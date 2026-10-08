import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  dropReservation,
  planThrow,
  postNotice,
  readReservation,
  readTrap,
  readTrapAnchor,
  reserveTrap,
  rosterByAddress,
  shellQuote,
  terminalAppName,
  isTerminalApp,
  TERMINAL_APPS,
  trapLabel,
  trapRef,
  writeTrapAnchor,
  DEFAULT_TRAP_START_SECS,
  TrapStartingError,
  type Config,
  type RosterEntry,
  type TerminalApp,
  type ThrowPlanRow,
  type TrapRegistration,
} from '@lobstah/core';
import { prepareReuse, restoreWorktree } from '@lobstah/worktree';
import { modelForHarness, toonHelp, toonKV, toonTable } from '@lobstah/core';
import { randomUUID } from 'node:crypto';

/** One terminal tab to open: a directory, an environment, and a command line. */
export interface TerminalLaunch {
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

/**
 * Opens a command in a new terminal tab. One adapter per app; the throw
 * never runs a harness itself.
 */
export interface TerminalAdapter {
  app: TerminalApp;
  launch(launch: TerminalLaunch): Promise<void>;
}

/** The shell text a terminal runs: `cd <dir> && VAR=value <argv>`, every word quoted. */
export function launchShellText(launch: TerminalLaunch): string {
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [`cd ${shellQuote(launch.cwd)} &&`, ...env, ...launch.argv.map(shellQuote)].join(' ');
}

const execFileP = promisify(execFile);

/**
 * AppleScript that takes the shell text as its first argument. The script
 * text is fixed: nothing from the trap, the path, or the prompt is ever
 * spliced into it, so no AppleScript quoting is needed.
 */
const APPLESCRIPT: Record<TerminalApp, string[]> = {
  terminal: ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run'],
  iterm: [
    'on run argv',
    'tell application "iTerm"',
    'activate',
    'set w to (create window with default profile)',
    'tell current session of w to write text (item 1 of argv)',
    'end tell',
    'end run',
  ],
};

/** The macOS adapter for a terminal app. */
export function macTerminalAdapter(app: TerminalApp): TerminalAdapter {
  return {
    app,
    async launch(launch) {
      if (process.platform !== 'darwin') throw new Error(`${terminalAppName(app)} runs only on macOS`);
      const args = APPLESCRIPT[app].flatMap((line) => ['-e', line]);
      try {
        await execFileP('osascript', [...args, launchShellText(launch)], { timeout: 30_000 });
      } catch (err) {
        const detail = ((err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err))).trim();
        throw new Error(
          `${terminalAppName(app)} did not open a tab: ${detail}` +
            (/not allowed|-1743|not authori[sz]ed/i.test(detail) ? ' — allow this terminal to control it in System Settings › Privacy & Security › Automation' : ''),
        );
      }
    },
  };
}

/** What the trap's harness is started with, and which profile settings it could not apply. */
export interface StartCommand extends TerminalLaunch {
  /** Profile config keys this harness has no flag for. */
  unapplied: string[];
}

/**
 * A harness command line whose first prompt redeems `ticket`. `resume`
 * reopens a saved session; without it the session is new. Model and config
 * become the harness's own flags; a config key with no flag is returned as
 * unapplied.
 */
export function harnessCommand(opts: {
  harness: string;
  cwd: string;
  ticket: string;
  resume?: string;
  model?: string;
  config?: Record<string, string>;
}): StartCommand {
  const unapplied: string[] = [];
  if (opts.harness === 'claude') {
    const argv = ['claude'];
    if (opts.resume) argv.push('--resume', opts.resume);
    if (opts.model) argv.push('--model', opts.model);
    for (const [key, value] of Object.entries(opts.config ?? {})) {
      if (key === 'effort') argv.push('--effort', value);
      else if (key === 'permissionMode') argv.push('--permission-mode', value);
      else unapplied.push(key);
    }
    argv.push(`/lobstah:trap soak --ticket ${opts.ticket}`);
    return { cwd: opts.cwd, env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, argv, unapplied };
  }
  if (opts.harness === 'codex') {
    const argv = ['codex'];
    if (opts.model) argv.push('-m', opts.model);
    for (const [key, value] of Object.entries(opts.config ?? {})) {
      if (key === 'effort') argv.push('-c', `model_reasoning_effort=${JSON.stringify(value)}`);
      else unapplied.push(key);
    }
    if (opts.resume) argv.push('resume', opts.resume);
    argv.push(`$lobstah:trap soak --ticket ${opts.ticket}`);
    return { cwd: opts.cwd, env: {}, argv, unapplied };
  }
  throw new Error(`no start command for harness ${opts.harness}`);
}

/**
 * The start command for a planned throw. Resume reopens the saved session
 * from the directory its history is keyed by; a cold start opens a new
 * session in the trap's worktree. Either way the first prompt redeems the
 * ticket, so the session signs on under the trap's own id and name.
 */
export function startCommand(row: ThrowPlanRow, entry: RosterEntry, ticket: string): StartCommand {
  const resume = row.action === 'resume';
  return harnessCommand({
    harness: row.harness ?? entry.harness,
    cwd: resume ? (row.resumeFrom ?? entry.worktree) : entry.worktree,
    ticket,
    ...(resume ? { resume: entry.sessionId } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.config ? { config: row.config } : {}),
  });
}

export interface ThrowResult {
  trap: string;
  /** resume and cold bring a rostered trap back; new is a fresh trap. */
  action: 'resume' | 'cold' | 'new';
  why: string;
  checkout: 'kept' | 'recreated' | 'created';
  terminal: TerminalApp;
  harness: string;
  command: string;
  unapplied: string[];
  /** The registration once the trap parked. */
  registration: TrapRegistration;
  seconds: number;
}

type Launched = Pick<ThrowResult, 'trap' | 'action' | 'why' | 'checkout' | 'terminal' | 'command'>;

/** What every throw takes. */
export interface ThrowOptions {
  cfg: Config;
  by?: string;
  timeoutSecs?: number;
  adapter?: (app: TerminalApp) => TerminalAdapter;
  pollMs?: number;
  /** The batch this throw belongs to: its trap's availability is the batch's summary. */
  batch?: string;
  onLaunch?: (launched: Launched) => void;
}

/** A throw that launched but did not come back in time. */
export class ThrowTimeoutError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveAdapter(opts: ThrowOptions, terminal: unknown, label: string, from: string): TerminalAdapter {
  if (!isTerminalApp(terminal)) {
    throw new Error(`cannot throw ${label}: terminal "${String(terminal)}" (${from}) is not supported — use ${TERMINAL_APPS.join(' or ')}`);
  }
  return (opts.adapter ?? macTerminalAdapter)(terminal);
}

/**
 * Withdraw a throw's reservation and say why: a late session cannot redeem
 * the ticket, and nothing about the trap's roster record changed.
 */
function giveUp(trapId: string, label: string, repo: string | undefined, retry: string, started: number, reason: string): void {
  if (!readReservation(trapId)) return;
  dropReservation(trapId);
  postNotice({
    kind: 'trap-start-failed',
    text: `trap ${label} did not come back: ${reason}. Its reservation is withdrawn — \`${retry}\` tries again.`,
    refId: trapId,
    repo,
    dedupeKey: `throw-failed-${trapId}-${started}`,
  });
}

/** Open the command, then wait until the trap signed on after `started` and parked. */
async function launchAndWait(
  opts: ThrowOptions,
  w: { trapId: string; label: string; repo?: string; retry: string; ticket: string; command: StartCommand; adapter: TerminalAdapter; started: number; launched: Omit<Launched, 'command'> },
): Promise<ThrowResult> {
  const timeoutSecs = opts.timeoutSecs ?? DEFAULT_TRAP_START_SECS;
  try {
    await w.adapter.launch(w.command);
  } catch (err) {
    giveUp(w.trapId, w.label, w.repo, w.retry, w.started, err instanceof Error ? err.message : String(err));
    throw err;
  }
  const command = launchShellText({ ...w.command, argv: w.command.argv.map((a) => a.replace(w.ticket, '<ticket>')) });
  opts.onLaunch?.({ ...w.launched, command });
  const deadline = w.started + timeoutSecs * 1000;
  for (;;) {
    const reg = readTrap(w.trapId);
    const fresh = reg !== undefined && Date.parse(reg.signedOnAt) >= w.started - 1000;
    if (fresh && reg.firstParkedAt) {
      return {
        ...w.launched,
        command,
        harness: reg.harness,
        unapplied: w.command.unapplied,
        registration: reg,
        seconds: Math.round((Date.now() - w.started) / 1000),
      };
    }
    if (Date.now() >= deadline) {
      if (fresh) throw new ThrowTimeoutError(`${w.label} signed on but has not listened within ${timeoutSecs}s — it is live; check its session`);
      giveUp(w.trapId, w.label, w.repo, w.retry, w.started, `no sign-on within ${timeoutSecs}s`);
      throw new ThrowTimeoutError(`${w.label} did not sign on within ${timeoutSecs}s; its reservation is withdrawn and the roster is unchanged`);
    }
    await sleep(opts.pollMs ?? 500);
  }
}

/**
 * `lobstah man throw <name>`: bring one rostered trap back and wait until it
 * listens. The plan decides resume or cold start and whether the checkout is
 * kept or recreated; a same-id reservation fences a second launch; the
 * terminal adapter opens the session; the throw returns only after the
 * trap signed on under its own id and parked. On a timeout the reservation
 * is withdrawn, so a late session cannot take the trap, and the roster stays
 * as it was.
 */
export async function throwTrap(opts: ThrowOptions & { address: string }): Promise<ThrowResult> {
  const started = Date.now();
  const [row] = planThrow(opts.cfg, { names: [opts.address] });
  const entry = rosterByAddress(opts.address);
  if (!row || !entry) throw new Error(`no roster record for ${opts.address} — \`lobstah man roster\` lists the traps a throw can bring back`);
  const label = trapLabel(entry);
  if (row.action === 'skip') throw new TrapStartingError(`not throwing ${label}: ${row.why}`);
  if (row.action === 'unresolved') throw new Error(`cannot throw ${label}: ${row.why}`);
  const terminal = row.terminal ?? 'terminal';
  const adapter = resolveAdapter(opts, terminal, label, row.terminalFrom ?? 'default');
  const repo = opts.cfg.repos[entry.repo!]!;
  const retry = `lobstah man throw ${entry.name}`;

  // The fence: one reservation per trap, created exclusively.
  const { ticket } = reserveTrap({
    repo: entry.repo!,
    harness: row.harness,
    name: entry.name,
    startSecs: opts.timeoutSecs ?? DEFAULT_TRAP_START_SECS,
    by: opts.by,
    returning: { trapId: entry.trapId, worktree: entry.worktree },
    ...(opts.batch ? { batch: opts.batch } : {}),
  });

  let checkout: ThrowResult['checkout'] = 'kept';
  let command: StartCommand;
  try {
    if (row.checkout === 'recreate') {
      const branch = entry.branch ?? entry.soakBranch ?? `lobstah/soak-${entry.trapId}`;
      const restored = await restoreWorktree(repo, entry.worktree, { branch, ref: trapRef(entry.trapId) });
      writeTrapAnchor(restored.dir, {
        trapId: entry.trapId,
        name: entry.name,
        createdBy: 'soak',
        sessionId: entry.sessionId,
        repo: entry.repo,
        ...(entry.soakBranch ? { branch: entry.soakBranch } : {}),
      });
      checkout = 'recreated';
    } else if (readTrapAnchor(entry.worktree)?.trapId === entry.trapId && repo.setup?.length) {
      // Kept as it is: branch and HEAD stay; setup reruns only when a lockfile changed.
      await prepareReuse(repo, entry.worktree);
    }
    command = startCommand(row, entry, ticket);
  } catch (err) {
    giveUp(entry.trapId, label, entry.repo, retry, started, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return launchAndWait(opts, {
    trapId: entry.trapId,
    label,
    repo: entry.repo,
    retry,
    ticket,
    command,
    adapter,
    started,
    launched: { trap: label, action: row.action, why: row.why, checkout, terminal },
  });
}

/** The harness, model, and effort a fresh trap starts with: the repo's harness defaults, else the global ones. */
export function freshProfile(cfg: Config, repoKey: string, harnessFlag?: string): { harness: string; model?: string; config?: Record<string, string> } {
  const repo = cfg.repos[repoKey]?.harness ?? {};
  const harness = harnessFlag ?? repo.default ?? cfg.harness.default ?? 'claude';
  const { model } = modelForHarness(harness, repo.model ?? cfg.harness.model);
  const effort = repo.effort ?? cfg.harness.effort;
  return { harness, ...(model ? { model } : {}), ...(effort ? { config: { effort } } : {}) };
}

/**
 * `lobstah man throw --new`: start one fresh trap for a repo. It reserves a
 * new id and name, opens a session in the repo's primary checkout whose
 * soak creates the trap's worktree, and waits until it listens.
 */
export async function throwNew(opts: ThrowOptions & { repo: string; harness?: string; request?: string }): Promise<ThrowResult> {
  const started = Date.now();
  const repo = opts.cfg.repos[opts.repo];
  if (!repo) throw new Error(`no repo "${opts.repo}" is configured (configured: ${Object.keys(opts.cfg.repos).join(', ') || 'none'})`);
  const profile = freshProfile(opts.cfg, opts.repo, opts.harness);
  const terminal = opts.cfg.soak.terminal ?? 'terminal';
  const adapter = resolveAdapter(opts, terminal, `a new ${opts.repo} trap`, opts.cfg.soak.terminal ? 'config' : 'default');
  const { reservation, ticket } = reserveTrap({
    repo: opts.repo,
    harness: profile.harness,
    startSecs: opts.timeoutSecs ?? DEFAULT_TRAP_START_SECS,
    by: opts.by,
    ...(opts.request ? { request: opts.request } : {}),
    ...(opts.batch ? { batch: opts.batch } : {}),
  });
  const label = trapLabel(reservation);
  const command = harnessCommand({ harness: profile.harness, cwd: repo.path, ticket, ...(profile.model ? { model: profile.model } : {}), ...(profile.config ? { config: profile.config } : {}) });
  return launchAndWait(opts, {
    trapId: reservation.trapId,
    label,
    repo: opts.repo,
    retry: `lobstah man throw --new --repo ${opts.repo}`,
    ticket,
    command,
    adapter,
    started,
    launched: { trap: label, action: 'new', why: `fresh ${opts.repo} trap from the ${profile.harness} defaults`, checkout: 'created', terminal },
  });
}

/** One trap's outcome in a batch. */
export interface BatchResult {
  trap: string;
  result: 'resumed' | 'cold' | 'new' | 'skipped' | 'failed';
  why: string;
  seconds?: number;
}

/**
 * A batch throw: every selected roster trap (`--all`, `--repo`), or `count`
 * fresh ones (`--new`). Launches run at once, with no limit. A trap the plan
 * skips or cannot resolve is reported, not attempted; one that fails does not
 * stop the others. The batch posts one `trap-batch` notice when every throw
 * has settled; its traps post no availability wakes of their own.
 */
export async function throwBatch(
  opts: ThrowOptions & ({ rows: ThrowPlanRow[] } | { repo: string; count: number; harness?: string }),
): Promise<BatchResult[]> {
  const batch = opts.batch ?? randomUUID();
  const each = { ...opts, batch };
  const jobs: Array<Promise<BatchResult>> = [];
  if ('rows' in opts) {
    for (const row of opts.rows) {
      const trap = trapLabel(row);
      if (row.action === 'skip' || row.action === 'unresolved') {
        jobs.push(Promise.resolve({ trap, result: 'skipped', why: row.why }));
        continue;
      }
      jobs.push(
        throwTrap({ ...each, address: `wt:${row.trapId}` }).then(
          (r) => ({ trap, result: r.action === 'resume' ? 'resumed' : 'cold', why: r.why, seconds: r.seconds }) as BatchResult,
          (err: unknown) => ({ trap, result: 'failed', why: err instanceof Error ? err.message : String(err) }) as BatchResult,
        ),
      );
    }
  } else {
    for (let i = 0; i < opts.count; i++) {
      jobs.push(
        throwNew({ ...each, repo: opts.repo, ...(opts.harness ? { harness: opts.harness } : {}) }).then(
          (r) => ({ trap: r.trap, result: 'new', why: r.why, seconds: r.seconds }) as BatchResult,
          (err: unknown) => ({ trap: `new ${opts.repo} trap ${i + 1}`, result: 'failed', why: err instanceof Error ? err.message : String(err) }) as BatchResult,
        ),
      );
    }
  }
  const results = await Promise.all(jobs);
  const count = (r: BatchResult['result']) => results.filter((x) => x.result === r).length;
  const failed = results.filter((r) => r.result === 'failed');
  const back = count('resumed') + count('cold') + count('new');
  postNotice({
    kind: 'trap-batch',
    text:
      `batch throw settled: ${back} available (${count('resumed')} resumed, ${count('cold')} cold, ${count('new')} new), ` +
      `${count('skipped')} skipped, ${failed.length} failed` +
      (failed.length ? ` — failed: ${failed.map((f) => f.trap).join(', ')}` : '') +
      (back ? ` — available: ${results.filter((r) => r.result !== 'skipped' && r.result !== 'failed').map((r) => r.trap).join(', ')}` : ''),
    refId: batch,
    ...('repo' in opts ? { repo: opts.repo } : {}),
    by: opts.by,
  });
  return results;
}

/** What `man throw` prints once the terminal opened. */
export function launchedText(launched: Launched, timeoutSecs = DEFAULT_TRAP_START_SECS): string {
  return toonKV({
    trap: launched.trap,
    start: launched.action,
    why: launched.why,
    checkout: launched.checkout,
    terminal: terminalAppName(launched.terminal),
    command: launched.command,
    waiting: `for sign-on and first park (up to ${timeoutSecs}s)`,
  });
}

/** What `man throw` prints once the trap listens. */
export function backText(result: ThrowResult): string {
  const address = result.registration.name ?? `wt:${result.registration.trapId}`;
  return [
    toonKV({
      back: `${result.trap} is listening (${result.seconds}s)`,
      session: result.registration.sessionId,
      harness: result.harness,
      ...(result.unapplied.length ? { unapplied: `profile config ${result.unapplied.join(', ')} has no ${result.harness} flag; not applied` } : {}),
    }),
    toonHelp([`lobstah dispatch --repo <key> --for ${address} --brief <file.md>   (address work to it)`]),
  ].join('\n');
}

/** A batch's per-trap results. */
export function batchText(results: BatchResult[]): string {
  return toonTable('throw', results.map((r) => ({ trap: r.trap, result: r.result, seconds: r.seconds ?? '', why: r.why })), ['trap', 'result', 'seconds', 'why']);
}
