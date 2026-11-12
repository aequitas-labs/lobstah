import { execFileSync, spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkHeavyLine, COMPILED_BINARY, formatHeavyView, heavyDir, heavyRunningText, heavyView, heavyWorkerEnv, heavyWorkers,
  joinHeavyLine, laneDirs, laneOf, loadConfig, ordinal, readTrap, readStatusLog, readWorktreeLock, releaseHeavyTicket,
  sendTrapMessage, sendMessageOnce, heavyResultDeliveryId, heavyResultText, setHeavyGroup, tickHeavyTicket, toonKV, trapIdAbove,
} from '@lobstah/core';
import type { Descriptor, HeavyJoin, Lane } from '@lobstah/core';

const POLL_MS = 2000;
const TICK_MS = 5000;
/** A holder that lost its place exits with this, having run nothing. */
const EXIT_CANCELLED = 75;
const LOG_KEEP_MS = 7 * 86_400_000;
/** Set on the detached holder `--bg` starts: where its log goes. */
const BG_ENV = 'LOBSTAH_HEAVY_BG';
const TICKET_ENV = 'LOBSTAH_HEAVY_TICKET';
/** The output relay owns the command's pipes even if its queue holder exits. */
const RELAY_ENV = 'LOBSTAH_HEAVY_RELAY';

const say = (line: string): void => {
  process.stderr.write(`heavy: ${line}\n`);
};

function gitRepoName(cwd: string): string | undefined {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    return path.basename(path.dirname(common));
  } catch {
    return undefined;
  }
}

function worktreeRootAbove(dir: string): string | undefined {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    if (path.dirname(at) === at) return undefined;
  }
}

function descriptorRepo(id: string, lane: Lane): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'descriptor.json'), 'utf8')) as Descriptor).repo;
  } catch {
    return undefined;
  }
}

/** Who is asking, from the worktree: its trap, or the dispatch whose runner holds it. */
export function heavyIdentity(cwd: string, env: NodeJS.ProcessEnv = process.env): Omit<HeavyJoin, 'pid' | 'command'> {
  const out: Omit<HeavyJoin, 'pid' | 'command'> = {};
  const session = (env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID)?.trim();
  if (session) out.session = session;
  const trapId = trapIdAbove(cwd);
  const reg = trapId ? readTrap(trapId) : undefined;
  if (reg) {
    out.trap = reg.trapId;
    if (reg.name) out.label = reg.name;
    if (reg.repo) out.repo = reg.repo;
    const lane = reg.claimed ? laneOf(reg.claimed) : undefined;
    if (reg.claimed && lane) {
      out.dispatch = reg.claimed;
      out.lane = lane;
    }
  } else {
    const root = worktreeRootAbove(cwd);
    const lock = root ? readWorktreeLock(root) : undefined;
    if (lock && lock.kind !== 'warm') {
      out.dispatch = lock.id;
      out.lane = lock.lane;
      const repo = descriptorRepo(lock.id, lock.lane);
      if (repo) out.repo = repo;
    }
  }
  if (!out.repo) {
    const repo = gitRepoName(cwd);
    if (repo) out.repo = repo;
  }
  return out;
}

export function commandLabel(argv: string[]): string {
  const label = argv.join(' ');
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal ? os.constants.signals[signal] : undefined;
  return n ? 128 + n : 1;
}

/**
 * Windows finds `npx` and `pnpm` only through the shell, which joins arguments
 * unquoted, so quote them here. An `.exe` needs no shell. Elsewhere, no shell.
 */
export function windowsCommand(argv: string[], platform: NodeJS.Platform = process.platform): [string, string[], boolean] {
  if (platform !== 'win32' || /\.exe$/i.test(argv[0]!)) return [argv[0]!, argv.slice(1), false];
  const quote = (arg: string) => (/^[\w\-./\\:=@]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
  return [quote(argv[0]!), argv.slice(1).map(quote), true];
}

/** Run `argv`, wired to this process. Resolves with its exit code. */
function runChild(argv: string[], env: NodeJS.ProcessEnv, hooks: { input?: Buffer; log?: string; relay?: boolean; onGroup?: (group: number) => void; onTick?: () => void } = {}): Promise<number> {
  // Its own process group, so a killed wrapper leaves a command whose load is
  // still visible to the line. A command on a terminal stays in the foreground.
  const detached = !hooks.relay && process.platform !== 'win32' && !process.stdin.isTTY;
  return new Promise((resolve) => {
    const relay = hooks.log && !hooks.relay;
    const self = COMPILED_BINARY ? [] : [fs.realpathSync(process.argv[1]!)];
    const command = relay ? [process.execPath, ...self, 'heavy', '--', ...argv] : argv;
    const [file, args, shell] = windowsCommand(command);
    const output = hooks.relay && hooks.log ? fs.createWriteStream(hooks.log, { flags: 'a', mode: 0o600 }) : undefined;
    output?.on('error', error => say(`could not retain output: ${error.message}`));
    const stdio: StdioOptions = [hooks.input ? 'pipe' : 'inherit', output ? 'pipe' : 'inherit', output ? 'pipe' : 'inherit'];
    const child = spawn(file, args, { stdio, env: relay ? { ...env, [RELAY_ENV]: '1' } : env, detached, shell, windowsHide: true });
    if (output) {
      child.stdout?.pipe(process.stdout, { end: false });
      child.stderr?.pipe(process.stderr, { end: false });
      child.stdout?.pipe(output, { end: false });
      child.stderr?.pipe(output, { end: false });
    }
    if (hooks.input) {
      // A hook that never reads its stdin closes the pipe: not an error.
      child.stdin?.on('error', () => {});
      child.stdin?.end(hooks.input);
    }
    const forward = (signal: NodeJS.Signals) => () => {
      if (!detached || child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map((s) => [s, forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const timer = hooks.onTick ? setInterval(hooks.onTick, TICK_MS) : undefined;
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      for (const [s, h] of handlers) process.off(s, h);
      if (output && !output.destroyed) output.end(() => resolve(code));
      else resolve(code);
    };
    if (detached && child.pid !== undefined) hooks.onGroup?.(child.pid);
    child.once('error', (err) => {
      say(`could not start ${argv[0]}: ${err.message}`);
      finish(127);
    });
    child.once('close', (code, signal) => finish(exitCodeOf(code, signal)));
  });
}

type Outcome = { exit: number; ranCommand: boolean; seq?: number; reason?: string };

/** Wait for a slot, run the command, free the slot. A queue failure runs the command without one. */
export async function runInLine(
  argv: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  opts: { label?: string; input?: Buffer; log?: string } = {},
): Promise<Outcome> {
  const { input } = opts;
  if (baseEnv[TICKET_ENV]) return { exit: await runChild(argv, baseEnv, { input }), ranCommand: true };
  const unqueued = async (err: unknown): Promise<Outcome> => {
    say(`running without a slot: the line failed (${err instanceof Error ? err.message : String(err)})`);
    return { exit: await runChild(argv, baseEnv, { input }), ranCommand: true };
  };

  let seq: number;
  const who = heavyIdentity(cwd, baseEnv);
  let log = opts.log;
  if (!log && (who.dispatch || who.trap) && !process.stdin.isTTY) {
    try { log = createLog(); } catch (error) { say(`could not retain output: ${error instanceof Error ? error.message : String(error)}`); }
  }
  try {
    seq = joinHeavyLine({ ...who, ...(log ? { log } : {}), pid: process.pid, command: opts.label ?? commandLabel(argv) }).seq;
  } catch (err) {
    return unqueued(err);
  }

  // A person's Ctrl-C leaves the line. A tool's kill keeps the place for a retry.
  const leave = () => {
    try {
      releaseHeavyTicket(seq);
    } catch {
      /* the next check clears it */
    }
    process.exit(130);
  };
  const killed = (code: number) => () => process.exit(code);
  const onTerm = killed(143);
  const onHup = killed(129);
  process.on('SIGINT', leave);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  const stopWaitingHandlers = () => {
    process.off('SIGINT', leave);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  };

  let announced = false;
  let slot = 0;
  let slots = 0;
  for (;;) {
    let step;
    try {
      step = checkHeavyLine(seq);
    } catch (err) {
      stopWaitingHandlers();
      return unqueued(err);
    }
    if (step.kind === 'run') {
      ({ slot, slots } = step);
      break;
    }
    if (step.kind === 'cancelled') {
      stopWaitingHandlers();
      say(`left the line without running: ${step.reason}`);
      return { exit: EXIT_CANCELLED, ranCommand: false, seq, reason: step.reason };
    }
    if (step.kind === 'lost') {
      stopWaitingHandlers();
      return unqueued(new Error('its ticket disappeared'));
    }
    if (!announced) {
      announced = true;
      const running = heavyRunningText(step.running);
      say(`in line, ${ordinal(step.position)}.${running ? ` Running: ${running}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  stopWaitingHandlers();
  say(`running, slot ${slot} of ${slots}`);

  let workers = 0;
  try {
    workers = heavyWorkers(loadConfig().heavy);
  } catch {
    /* no limit is better than no run */
  }
  const env = { ...baseEnv, [TICKET_ENV]: String(seq), ...(workers ? heavyWorkerEnv(workers, baseEnv) : {}) };
  let exit: number | undefined;
  try {
    exit = await runChild(argv, env, {
      input,
      ...(log && !opts.log ? { log } : {}),
      onGroup: (group) => {
        try {
          setHeavyGroup(seq, group);
        } catch {
          /* the wrapper's own pid still holds the ticket */
        }
      },
      onTick: () => {
        try {
          if (tickHeavyTicket(seq)) say('past the time limit: this keeps running, without a slot');
        } catch {
          /* a missed tick only delays the limit */
        }
      },
    });
    return { exit, ranCommand: true, seq };
  } finally {
    try {
      releaseHeavyTicket(seq, exit);
    } catch {
      /* the next check clears it once this process is gone */
    }
  }
}

function pruneLogs(dir: string, now = Date.now()): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > LOG_KEEP_MS) fs.rmSync(file, { force: true });
    } catch {
      /* someone else pruned it */
    }
  }
}

/** Allocate retained output for an owned command or a detached holder. */
function createLog(): string {
  const dir = path.join(heavyDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  pruneLogs(dir);
  const log = path.join(dir, `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.log`);
  fs.closeSync(fs.openSync(log, 'ax', 0o600));
  return log;
}

function startBackground(argv: string[]): void {
  const log = createLog();
  const fd = fs.openSync(log, 'a');
  try {
    const self = [...(COMPILED_BINARY ? [] : [fs.realpathSync(process.argv[1]!)])];
    const child = spawn(process.execPath, [...self, 'heavy', '--', ...argv], {
      detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, [BG_ENV]: log }, windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  console.log(toonKV({ heavy: 'in the background', command: commandLabel(argv), log, result: "this dispatch's inbox" }));
}

/** The background holder is done: tell the dispatch, or the trap between dispatches. */
function postResult(who: ReturnType<typeof heavyIdentity>, argv: string[], log: string, outcome: Outcome): void {
  const text = outcome.ranCommand
    ? heavyResultText({ command: commandLabel(argv), exit: outcome.exit, log })
    : `heavy: ${commandLabel(argv)} did not run: ${outcome.reason ?? 'removed from the line'}\nlog: ${log}`;
  try {
    if (who.dispatch && who.lane) {
      const entry = readStatusLog(who.dispatch, who.lane).at(-1);
      const pauseAt = entry?.verb === 'paused' && entry.waitingOn === 'heavy' ? entry.at : undefined;
      sendMessageOnce(who.dispatch, who.lane, heavyResultDeliveryId({ seq: outcome.seq, joinedAt: log, dispatch: who.dispatch }, pauseAt), text, 'heavy');
    }
    else if (who.trap) sendTrapMessage(who.trap, 'heavy', text);
  } catch (err) {
    say(`could not post the result: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const NO_COMMIT = /^0+$/;

/** What this ref's push changes, or undefined when that can't be told. */
function changedPaths(cwd: string, remote: string, localSha: string, remoteSha: string): string[] | undefined {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  let base = remoteSha;
  if (NO_COMMIT.test(remoteSha)) {
    const found = [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`].flatMap((ref) => {
      try {
        return [git('merge-base', localSha, ref).trim()];
      } catch {
        return [];
      }
    })[0];
    if (!found) return undefined;
    base = found;
  }
  try {
    return git('diff', '--name-only', '-z', base, localSha).split('\0').filter(Boolean);
  } catch {
    return undefined; // the remote commit isn't here: unknown, so not light
  }
}

/**
 * A push the repo's hook handles cheaply, so waiting in line would be for
 * nothing. The hook still runs in full, so a wrong setting costs only load.
 */
export function isLightPush(refs: string, remote: string, cwd: string, light: { lightRefs: string[]; lightPaths: string[] } | undefined): boolean {
  const lines = refs.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localSha || !remoteRef || !remoteSha) return false;
    if (NO_COMMIT.test(localSha)) return true; // deleting a branch checks nothing
    if (light?.lightRefs.includes(remoteRef)) return true;
    if (!light?.lightPaths.length) return false;
    const changed = changedPaths(cwd, remote, localSha, remoteSha);
    return !!changed?.length && changed.every((file) => light.lightPaths.some((prefix) => file.startsWith(prefix)));
  });
}

/** The shim's pre-push: a slot, unless the push is light, then the repo's real hook. */
export async function heavyPushHook(argv: string[]): Promise<void> {
  const input = fs.readFileSync(0);
  const cwd = process.cwd();
  let light = false;
  try {
    const repo = heavyIdentity(cwd).repo;
    light = isLightPush(input.toString('utf8'), argv[1] ?? 'origin', cwd, repo ? loadConfig().heavy.repos[repo] : undefined);
  } catch {
    /* unknown counts as heavy */
  }
  const { exit } = light
    ? { exit: await runChild(argv, process.env, { input }) }
    : await runInLine(argv, process.env, cwd, { label: 'git push', input });
  process.exit(exit);
}

export async function heavyCommand(argv: string[], opts: { bg?: boolean; json?: boolean }): Promise<void> {
  if (process.env[RELAY_ENV]) {
    const view = heavyView();
    const seq = Number(process.env[TICKET_ENV]);
    const ticket = [...view.running, ...view.over].find(ticket => ticket.seq === seq);
    if (!ticket?.log) throw new Error('the heavy output relay has no live ticket');
    const env = { ...process.env };
    delete env[RELAY_ENV];
    const exit = await runChild(argv, env, { log: ticket.log, relay: true });
    try { releaseHeavyTicket(seq, exit); } catch { /* The holder or daemon retries delivery. */ }
    process.exit(exit);
  }
  if (argv.length === 0) {
    if (opts.bg) throw new Error('heavy --bg needs a command: lobstah heavy --bg -- <command>');
    const view = heavyView();
    console.log(opts.json ? JSON.stringify(view, null, 2) : formatHeavyView(view));
    return;
  }
  if (opts.bg) {
    startBackground(argv);
    return;
  }
  const log = process.env[BG_ENV];
  if (log) {
    const env = { ...process.env };
    delete env[BG_ENV];
    // Named now: by the time this ends, the trap may have moved to other work.
    const who = heavyIdentity(process.cwd(), env);
    const outcome = await runInLine(argv, env, process.cwd(), { log });
    postResult(who, argv, log, outcome);
    process.exit(outcome.exit);
  }
  const outcome = await runInLine(argv);
  process.exit(outcome.exit);
}
