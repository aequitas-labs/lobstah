import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OutputScrubber,
  RUN_RELAY,
  appendRunAudit,
  decisionDir,
  harnessProcessAlive,
  lobstahHome,
  listRunAttempts,
  processStartedAt,
  readArchivedDecision,
  readDecision,
  readRunAttempt,
  readRunOutput,
  readStoredRunScript,
  runOutputTail,
  withDirLock,
  writeRequest,
  writeRunAttempt,
} from '@lobstah/core';
import type { DecisionMeta, RunAttempt, RunCard, RunResult } from '@lobstah/core';
export type { RunResult } from '@lobstah/core';

/**
 * Running a run card (ume 3ef69c1d-026, intent run-execute). The glass
 * server runs the card's stored script, which run-routes.ts has just checked
 * against the card's hash and a passkey assertion, as Chris's user:
 * `/bin/bash --noprofile --norc <copy>` in the card's cwd, in its own process
 * group, with a minimal environment (never the glass's own). The inputs go
 * to stdin, one line each in declared order, and stdin then closes: never
 * argv (`ps` shows it) or the environment (`ps -E` shows it), never a file
 * or a log. Both output streams pass through the scrubber before any byte
 * leaves this process. Each attempt is saved, and its outcome wakes the
 * helm. The card remains available for retry until the person dismisses it.
 */

/** The answer keeps this much of the scrubbed output's tail. */
export const RUN_ANSWER_OUTPUT_MAX = 16 * 1024;
/** The live view on the card keeps this much. */
export const RUN_LIVE_OUTPUT_MAX = 256 * 1024;
/** After the time limit, how long a run has to stop before it is killed outright. */
export const RUN_KILL_GRACE_MS = 3_000;
/** The exit code a run that hit its time limit records, as timeout(1) does. */
export const RUN_TIMEOUT_EXIT = 124;
/** The longest value one input, or one console line, may carry. */
export const RUN_INPUT_MAX_CHARS = 8192;
/** What a secret console line is scrubbed as. */
export const RUN_SECRET_LINE_NAME = 'secret';

/**
 * The terminal relay for an interactive run (`--interactive`), run by
 * expect(1): it spawns the script under a pseudo-terminal, sends each line
 * of its own stdin to it, copies the terminal's output to stdout, and exits
 * with the script's status. On SIGTERM (the time limit) it kills the script,
 * which runs in its own session, and exits 124.
 */
export const RUN_RELAY_SCRIPT = `log_user 1
set timeout -1
trap { catch {exec /bin/kill -KILL -- -[exp_pid]}; exit 124 } {SIGTERM}
set pidfile [lindex $argv 0]
spawn -noecho {*}[lrange $argv 1 end]
set file [open $pidfile w]
puts $file [exp_pid]
close $file
fconfigure stdin -blocking 0 -buffering line
fileevent stdin readable {
  if {[gets stdin line] >= 0} { send -- "$line\r" } elseif {[eof stdin]} { fileevent stdin readable {} }
}
expect eof
lassign [wait] pid spawnid oserr status
exit $status
`;

/** The relay script on disk, rewritten from RUN_RELAY_SCRIPT before each interactive run. */
function relayFile(): string {
  const file = path.join(lobstahHome(), 'run', 'relay.exp');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, RUN_RELAY_SCRIPT, { mode: 0o600 });
  return file;
}

/** A run in progress or just ended, as the card's live view reads it. */
export interface LiveRun {
  key: string;
  attempt: RunAttempt;
  startedAt: number;
  /** The scrubbed output so far (its tail, past RUN_LIVE_OUTPUT_MAX). */
  output: string;
  /** Characters dropped from the front of `output`. */
  dropped: number;
  result?: RunResult;
  error?: string;
}

/** Check the typed inputs against the card: exactly its names, single-line strings. Returns the stdin text or a reason. */
export function runStdin(
  card: RunCard,
  inputs: unknown,
): { stdin: string; values: Array<{ name: string; value: string }> } | { reason: string } {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return { reason: 'The inputs are required.' };
  const given = inputs as Record<string, unknown>;
  const names = card.inputs.map((i) => i.name);
  if (Object.keys(given).some((k) => !names.includes(k))) return { reason: 'An input the card does not declare was sent.' };
  const values: Array<{ name: string; value: string }> = [];
  for (const name of names) {
    const value = given[name];
    if (typeof value !== 'string' || !value) return { reason: `${name} is required.` };
    if (value.length > RUN_INPUT_MAX_CHARS) return { reason: `${name} is longer than ${RUN_INPUT_MAX_CHARS} characters.` };
    // One line per input: a newline would shift every later input.
    if (/[\r\n\0]/.test(value)) return { reason: `${name} must be one line.` };
    values.push({ name, value });
  }
  return { stdin: values.map((v) => `${v.value}\n`).join(''), values };
}

/** The environment a run gets: enough to find tools, nothing of the glass's. */
export function runEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    USER: source.USER ?? os.userInfo().username,
    LANG: source.LANG ?? 'en_US.UTF-8',
    TMPDIR: source.TMPDIR ?? os.tmpdir(),
  };
}

const elapsed = (ms: number): string =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** The card's answer: how the run ended, and the scrubbed output's tail unless the card withholds it. */
export function runAnswerText(card: RunCard, result: RunResult, output: string): string {
  const head = result.interrupted
    ? `Run failed because the glass stopped (exit ${result.exitCode}).`
    : result.timedOut
      ? `Ran: timed out after ${card.timeoutSecs}s and was stopped (exit ${RUN_TIMEOUT_EXIT}).`
      : result.stopped
        ? `Run stopped (exit ${result.exitCode}).`
        : `Ran: exit ${result.exitCode} in ${elapsed(result.durationMs)}.`;
  if (card.output === 'exit') return `${head} Output withheld (--output exit).`;
  const tail = output.length > RUN_ANSWER_OUTPUT_MAX ? output.slice(-RUN_ANSWER_OUTPUT_MAX) : output;
  const cut = tail.length < output.length ? `(last ${RUN_ANSWER_OUTPUT_MAX / 1024} KB)\n` : '';
  return `${head}\n\nScrubbed output:\n${cut}\`\`\`\n${tail.replace(/```/g, '`​``')}\n\`\`\``;
}

/** A live interactive run's console: where a line goes, and the scrubbers a secret line joins. */
interface RunConsole {
  write: (line: string) => void;
  scrubbers: OutputScrubber[];
  /** For a run started from the hosted glass: the page key that may type into it, and the next line's number. */
  relayed?: { attempt: string; lineKey?: string; next: number };
}

/** Deliver an outcome independently of whether its card still stands. Exit-mode output stays local. */
function notifyRunOutcome(meta: DecisionMeta & { run: RunCard }, attempt: RunAttempt, output: string): void {
  const result = attempt.result!;
  writeRequest(
    'decision-answer',
    {
      key: meta.key,
      title: meta.title,
      dispatch: meta.dispatch,
      lane: meta.lane,
      repo: meta.repo,
      grounds: meta.grounds,
      text: runAnswerText(meta.run, result, output),
      attachments: [],
      run: {
        id: attempt.id,
        state: attempt.state,
        exitCode: result.exitCode,
        tail: meta.run.output === 'exit' ? '' : runOutputTail(output).slice(-RUN_ANSWER_OUTPUT_MAX),
      },
    },
    'glass',
  );
}

/** Serialize start and restart recovery so two glass processes cannot claim the same card. */
function withRunLock<T>(key: string, action: () => T): T {
  const dir = path.join(lobstahHome(), 'run', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  return withDirLock(path.join(dir, key.replace(/[^a-z0-9-]/gi, '_')), action, {
    staleMs: 30_000,
    waitMs: 2000,
    busy: () => new Error('The run card is busy. Try again.'),
  });
}

/** Runs the glass started, by card key; one at a time per card. */
export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>();
  private readonly consoles = new Map<string, RunConsole>();
  private readonly pending = new Set<Promise<RunResult>>();
  private readonly stops = new Map<string, () => void>();

  constructor() {
    for (const attempt of listRunAttempts()) if (attempt.state === 'running') this.get(attempt.key);
  }

  get(key: string): LiveRun | undefined {
    const live = this.runs.get(key);
    const attempt = readRunAttempt(key);
    if (!attempt || live?.attempt.id === attempt.id) return live;
    const output = readRunOutput(attempt);
    const saved: LiveRun = {
      key,
      attempt,
      startedAt: Date.parse(attempt.startedAt),
      output,
      dropped: Math.max(0, (attempt.outputChars ?? output.length) - output.length),
      result: attempt.result,
    };
    if (attempt.state === 'running' && attempt.owner && !harnessProcessAlive(attempt.owner)) {
      withRunLock(key, () => {
        const current = readRunAttempt(key);
        if (current?.id !== attempt.id || current.state !== 'running' || !current.owner || harnessProcessAlive(current.owner)) return;
        attempt.owner = { pid: process.pid, startedAt: processStartedAt(process.pid) ?? '' };
        writeRunAttempt(attempt, saved.output);
        this.recover(saved);
      });
    }
    return saved;
  }

  /** End an interrupted owner process's attempt after stopping only its recorded process identities. */
  private recover(live: LiveRun): void {
    const meta = readDecision(live.key) ?? readArchivedDecision(live.key);
    if (!meta?.run) return;
    this.runs.set(live.key, live);
    const processes = live.attempt.processes ?? [];
    const signal = (value: NodeJS.Signals): void => {
      for (const child of processes) {
        if (!harnessProcessAlive(child)) continue;
        try {
          process.kill(-child.pid, value);
        } catch {
          /* The process ended between inspection and the signal. */
        }
      }
    };
    signal('SIGTERM');
    const recovery = new Promise<RunResult>((resolve) => {
      const finish = (): void => {
        signal('SIGKILL');
        const result: RunResult = {
          exitCode: 1,
          timedOut: false,
          interrupted: true,
          durationMs: Date.now() - live.startedAt,
          outputBytes: Buffer.byteLength(live.output),
          scrubbed: 0,
        };
        live.output += '\nThe glass stopped before this run finished.\n';
        live.result = result;
        live.attempt.result = result;
        live.attempt.state = 'failed';
        live.attempt.finishedAt = new Date().toISOString();
        live.attempt.outputChars = live.dropped + live.output.length;
        try {
          writeRunAttempt(live.attempt, live.output);
          notifyRunOutcome(meta as DecisionMeta & { run: RunCard }, live.attempt, live.output);
        } catch (error) {
          console.error(`Run ${live.key}: interrupted result could not be saved`, error);
        }
        fs.rmSync(path.join(lobstahHome(), 'run', 'active', live.attempt.id), { recursive: true, force: true });
        resolve(result);
      };
      if (processes.some(harnessProcessAlive)) setTimeout(finish, RUN_KILL_GRACE_MS);
      else finish();
    });
    this.pending.add(recovery);
    void recovery.finally(() => this.pending.delete(recovery));
  }

  /** Stop this card's process groups, including the interactive terminal's children. */
  stop(key: string): string | undefined {
    const stop = this.stops.get(key);
    if (!stop) return 'This card has no running command to stop.';
    stop();
    return undefined;
  }

  /**
   * Send one line to a card's live interactive run. A secret line's value is
   * scrubbed from everything the run prints after it, its echo included.
   * Returns why it was refused, or undefined when sent.
   */
  /** A live interactive run started from the hosted glass: its attempt, the page key that may type into it, and the number it takes next. */
  relayedConsole(key: string): { attempt: string; lineKey?: string; next: number } | undefined {
    const live = this.runs.get(key);
    const console = this.consoles.get(key);
    return live && !live.result && console?.relayed ? { ...console.relayed } : undefined;
  }

  /** Send a line to a card's live interactive run. A relayed line names its number, which must be the next one. */
  sendLine(key: string, line: unknown, secret: boolean, seq?: number): string | undefined {
    const live = this.runs.get(key);
    const console = this.consoles.get(key);
    if (!live || live.result || !console) return 'That card has no run waiting for a line.';
    if (typeof line !== 'string' || line.length > RUN_INPUT_MAX_CHARS)
      return `A line is text of at most ${RUN_INPUT_MAX_CHARS} characters.`;
    if (/[\r\n\0]/.test(line)) return 'Send one line at a time.';
    if (console.relayed && seq !== console.relayed.next) return 'That line was already sent, or one before it is missing.';
    if (console.relayed) console.relayed.next += 1;
    if (secret && line) for (const s of console.scrubbers) s.add({ name: RUN_SECRET_LINE_NAME, value: line });
    console.write(line);
    return undefined;
  }

  /** Wait until every attempt has ended and its outcome has been recorded. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Start the card's stored script with the typed inputs. Resolves when the
   * run has ended, its outcome is saved and the helm has been notified.
   */
  start(
    meta: DecisionMeta & { run: RunCard },
    values: Array<{ name: string; value: string }>,
    stdin: string,
    credentialId: string,
    options: { maxBytes: number; env?: NodeJS.ProcessEnv; relayed?: { lineKey?: string } } = { maxBytes: 1 << 20 },
  ): Promise<RunResult> {
    const card = meta.run;
    if (this.get(meta.key)?.attempt.state === 'running') throw new Error('This card is already running.');
    const startedAt = Date.now();
    const attempt: RunAttempt = {
      id: randomUUID(),
      key: meta.key,
      scriptSha256: card.scriptSha256,
      state: 'running',
      startedAt: new Date(startedAt).toISOString(),
      owner: { pid: process.pid, startedAt: processStartedAt(process.pid) ?? '' },
    };
    const stored = readStoredRunScript(decisionDir(meta.key)!);
    if (stored?.sha256 !== card.scriptSha256) throw new Error('The script changed. Reload the card.');
    const relay = card.interactive ? relayFile() : undefined;
    // Keep the verified execution copy stable if the card is withdrawn while bash opens it.
    const executionDir = path.join(lobstahHome(), 'run', 'active', attempt.id);
    fs.mkdirSync(executionDir, { recursive: true, mode: 0o700 });
    const scriptFile = path.join(executionDir, 'script');
    const pidFile = path.join(executionDir, 'terminal.pid');
    fs.writeFileSync(scriptFile, stored.text, { mode: 0o600 });
    try {
      withRunLock(meta.key, () => {
        if (readRunAttempt(meta.key)?.state === 'running') throw new Error('This card is already running.');
        writeRunAttempt(attempt, '');
      });
    } catch (error) {
      fs.rmSync(executionDir, { recursive: true, force: true });
      throw error;
    }
    const live: LiveRun = { key: meta.key, attempt, startedAt, output: '', dropped: 0 };
    this.runs.set(meta.key, live);
    console.info(`Run ${meta.key} started (${attempt.id}).`);
    const out = new OutputScrubber(values);
    const err = new OutputScrubber(values);
    let all = '';
    let persistTimer: NodeJS.Timeout | undefined;
    let terminalRecorded = false;
    const persist = (): void => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = undefined;
      attempt.outputChars = live.dropped + live.output.length;
      if (card.interactive && !terminalRecorded) {
        try {
          const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
          const start = Number.isSafeInteger(pid) && pid > 1 ? processStartedAt(pid) : undefined;
          if (start) {
            attempt.processes = [...(attempt.processes ?? []), { pid, startedAt: start }];
            terminalRecorded = true;
          }
        } catch {
          /* The terminal has not started yet. */
        }
      }
      try {
        writeRunAttempt(attempt, live.output);
        live.error = undefined;
      } catch (error) {
        live.error = 'The run history could not be saved. Check the glass log.';
        console.error(`Run ${meta.key}: history could not be saved`, error);
      }
    };
    const take = (text: string) => {
      if (!text) return;
      all += text;
      live.output += text;
      if (live.output.length > RUN_LIVE_OUTPUT_MAX) {
        live.dropped += live.output.length - RUN_LIVE_OUTPUT_MAX;
        live.output = live.output.slice(-RUN_LIVE_OUTPUT_MAX);
      }
      if (all.length > RUN_ANSWER_OUTPUT_MAX * 2) all = all.slice(-RUN_ANSWER_OUTPUT_MAX);
      if (!persistTimer) persistTimer = setTimeout(persist, 200);
    };
    const done = new Promise<RunResult>((resolve) => {
      let outputBytes = 0;
      const script = [card.interpreter, '--noprofile', '--norc', scriptFile];
      // An interactive run gets a terminal through the relay; a plain one reads EOF after its inputs.
      const [command, ...args] = relay ? [RUN_RELAY, '-f', relay, pidFile, ...script] : script;
      const child = spawn(command!, args, {
        cwd: card.cwd,
        env: options.env ?? runEnvironment(),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const childStart = child.pid ? processStartedAt(child.pid) : undefined;
      if (child.pid && childStart) attempt.processes = [{ pid: child.pid, startedAt: childStart }];
      persist();
      persistTimer = setTimeout(persist, 200);
      let timedOut = false;
      let stopped = false;
      let killTimer: NodeJS.Timeout | undefined;
      const group = (signal: NodeJS.Signals) => {
        let terminal: number | undefined;
        if (card.interactive) {
          try {
            terminal = Number(fs.readFileSync(pidFile, 'utf8').trim());
          } catch {
            /* The relay has not spawned yet. */
          }
        }
        for (const pid of [terminal, child.pid]) {
          if (!pid || !Number.isSafeInteger(pid) || pid < 2) continue;
          try {
            process.kill(-pid, signal);
          } catch {
            /* Already gone. */
          }
        }
      };
      const terminate = (): void => {
        group('SIGTERM');
        killTimer ??= setTimeout(() => group('SIGKILL'), RUN_KILL_GRACE_MS);
        killTimer.unref();
      };
      this.stops.set(meta.key, () => {
        stopped = true;
        terminate();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, card.timeoutSecs * 1000);
      child.stdout.on('data', (b: Buffer) => {
        outputBytes += b.length;
        take(out.push(b));
      });
      child.stderr.on('data', (b: Buffer) => {
        outputBytes += b.length;
        take(err.push(b));
      });
      // A script that never reads stdin closes it early: that is not an error.
      child.stdin.on('error', () => {});
      if (card.interactive) {
        child.stdin.write(stdin);
        this.consoles.set(meta.key, {
          write: (line) => child.stdin.write(`${line}\n`),
          scrubbers: [out, err],
          ...(options.relayed ? { relayed: { attempt: attempt.id, ...(options.relayed.lineKey ? { lineKey: options.relayed.lineKey } : {}), next: 0 } } : {}),
        });
      } else child.stdin.end(stdin);
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        this.stops.delete(meta.key);
        if (stopped || timedOut) group('SIGKILL');
        this.consoles.delete(meta.key);
        child.stdin.destroy();
        take(out.end());
        take(err.end());
        const result: RunResult = {
          exitCode: timedOut ? RUN_TIMEOUT_EXIT : stopped ? 130 : (code ?? 1),
          timedOut,
          stopped: stopped && !timedOut,
          durationMs: Date.now() - live.startedAt,
          outputBytes,
          scrubbed: out.replaced + err.replaced,
        };
        live.result = result;
        attempt.result = result;
        attempt.state = result.stopped ? 'stopped' : result.exitCode === 0 ? 'succeeded' : 'failed';
        attempt.finishedAt = new Date().toISOString();
        persist();
        console.info(`Run ${meta.key} ${attempt.state} (exit ${result.exitCode}).`);
        try {
          notifyRunOutcome(meta, attempt, all);
        } catch (error) {
          console.error(`Run ${meta.key}: the helm could not be notified`, error);
        }
        try {
          appendRunAudit({
            at: new Date().toISOString(),
            key: meta.key,
            title: meta.title,
            ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
            postedBy: meta.askedBy,
            ...(card.proposedBy ? { proposedBy: card.proposedBy } : {}),
            scriptSha256: card.scriptSha256,
            cwd: card.cwd,
            credentialId,
            exitCode: result.exitCode,
            timedOut,
            durationMs: result.durationMs,
            outputBytes,
            scrubbed: result.scrubbed,
          });
        } catch (error) {
          console.error(`Run ${meta.key}: the audit could not be saved`, error);
        }
        fs.rmSync(executionDir, { recursive: true, force: true });
        resolve(result);
      };
      child.on('error', (error) => {
        take(`The command could not start: ${error.message}\n`);
        finish(127);
      });
      child.on('close', (code) => finish(code));
    });
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
    return done;
  }
}
