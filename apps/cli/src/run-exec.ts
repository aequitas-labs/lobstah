import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { OutputScrubber, answerDecision, appendRunAudit, decisionDir, runScriptFile } from '@lobstah/core';
import type { DecisionMeta, RunCard } from '@lobstah/core';

/**
 * Running a run card (ume 3ef69c1d-026, intent run-execute). The glass
 * server runs the card's stored script, which run-routes.ts has just checked
 * against the card's hash and a passkey assertion, as Chris's user:
 * `/bin/bash --noprofile --norc <copy>` in the card's cwd, in its own process
 * group, with a minimal environment (never the glass's own). The inputs go
 * to stdin, one line each in declared order, and stdin then closes: never
 * argv (`ps` shows it) or the environment (`ps -E` shows it), never a file
 * or a log. Both output streams pass through the scrubber before any byte
 * leaves this process. When the run ends, its result answers the card and a
 * line goes to the run audit.
 */

/** The answer keeps this much of the scrubbed output's tail. */
export const RUN_ANSWER_OUTPUT_MAX = 64 * 1024;
/** The live view on the card keeps this much. */
export const RUN_LIVE_OUTPUT_MAX = 256 * 1024;
/** After the time limit, how long a run has to stop before it is killed outright. */
export const RUN_KILL_GRACE_MS = 3_000;
/** The exit code a run that hit its time limit records, as timeout(1) does. */
export const RUN_TIMEOUT_EXIT = 124;
/** The longest value one input may carry. */
export const RUN_INPUT_MAX_CHARS = 8192;

/** How a run ended. */
export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Bytes of scrubbed output. */
  outputBytes: number;
  /** How many input values the scrubber replaced. */
  scrubbed: number;
}

/** A run in progress or just ended, as the card's live view reads it. */
export interface LiveRun {
  key: string;
  startedAt: number;
  /** The scrubbed output so far (its tail, past RUN_LIVE_OUTPUT_MAX). */
  output: string;
  /** Characters dropped from the front of `output`. */
  dropped: number;
  result?: RunResult;
}

/** Check the typed inputs against the card: exactly its names, single-line strings. Returns the stdin text or a reason. */
export function runStdin(card: RunCard, inputs: unknown): { stdin: string; values: Array<{ name: string; value: string }> } | { reason: string } {
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

const elapsed = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** The card's answer: how the run ended, and the scrubbed output's tail unless the card withholds it. */
export function runAnswerText(card: RunCard, result: RunResult, output: string): string {
  const head = result.timedOut
    ? `Ran: timed out after ${card.timeoutSecs}s and was stopped (exit ${RUN_TIMEOUT_EXIT}).`
    : `Ran: exit ${result.exitCode} in ${elapsed(result.durationMs)}.`;
  if (card.output === 'exit') return `${head} Output withheld (--output exit).`;
  const tail = output.length > RUN_ANSWER_OUTPUT_MAX ? output.slice(-RUN_ANSWER_OUTPUT_MAX) : output;
  const cut = tail.length < output.length ? `(last ${RUN_ANSWER_OUTPUT_MAX / 1024} KB)\n` : '';
  return `${head}\n\nScrubbed output:\n${cut}\`\`\`\n${tail.replace(/```/g, '`​``')}\n\`\`\``;
}

/** Runs the glass started, by card key; one at a time per card. */
export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>();
  private readonly pending = new Set<Promise<RunResult>>();

  get(key: string): LiveRun | undefined {
    return this.runs.get(key);
  }

  /** Every run started so far has ended and answered its card. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Start the card's stored script with the typed inputs. Resolves when the
   * run has ended, its card is answered and its audit line written.
   */
  start(meta: DecisionMeta & { run: RunCard }, values: Array<{ name: string; value: string }>, stdin: string, credentialId: string, opts: { maxBytes: number; env?: NodeJS.ProcessEnv } = { maxBytes: 1 << 20 }): Promise<RunResult> {
    const card = meta.run;
    const live: LiveRun = { key: meta.key, startedAt: Date.now(), output: '', dropped: 0 };
    this.runs.set(meta.key, live);
    const out = new OutputScrubber(values);
    const err = new OutputScrubber(values);
    let all = '';
    const take = (text: string) => {
      if (!text) return;
      all += text;
      live.output += text;
      if (live.output.length > RUN_LIVE_OUTPUT_MAX) {
        live.dropped += live.output.length - RUN_LIVE_OUTPUT_MAX;
        live.output = live.output.slice(-RUN_LIVE_OUTPUT_MAX);
      }
      if (all.length > RUN_ANSWER_OUTPUT_MAX * 2) all = all.slice(-RUN_ANSWER_OUTPUT_MAX);
    };
    const done = new Promise<RunResult>((resolve) => {
      let outputBytes = 0;
      const child = spawn(card.interpreter, ['--noprofile', '--norc', runScriptFile(decisionDir(meta.key)!)], {
        cwd: card.cwd,
        env: opts.env ?? runEnvironment(),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let timedOut = false;
      const group = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          /* Already gone. */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        group('SIGTERM');
        setTimeout(() => group('SIGKILL'), RUN_KILL_GRACE_MS).unref();
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
      child.stdin.end(stdin);
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        take(out.end());
        take(err.end());
        const result: RunResult = {
          exitCode: timedOut ? RUN_TIMEOUT_EXIT : (code ?? 1),
          timedOut,
          durationMs: Date.now() - live.startedAt,
          outputBytes,
          scrubbed: out.replaced + err.replaced,
        };
        live.result = result;
        try {
          answerDecision({ key: meta.key, text: runAnswerText(card, result, all), by: 'glass', maxBytes: opts.maxBytes });
        } catch {
          /* Answered or withdrawn meanwhile: the audit still records the run. */
        }
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
        resolve(result);
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code));
    });
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
    return done;
  }
}
