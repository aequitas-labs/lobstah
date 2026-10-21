import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  dropReservation,
  guardNewTraps,
  repoTrapCount,
  selectRepoTrap,
  planThrow,
  postNotice,
  readReservation,
  readTrap,
  readTrapAnchor,
  reserveTrap,
  lobstahHome,
  configPermissionMode,
  normalizePermissionMode,
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
  /** The permission mode it starts in: `auto`, `bypassPermissions`, or a roster `permissionMode`. */
  mode: string;
}

/**
 * The permission mode a throw starts a trap in: `man throw --bypass`, then
 * the config it starts with (a roster profile over `[harness].permissionMode`
 * of the repo, then of the config; see planThrow and freshProfile),
 * otherwise auto. `bypass` is `bypassPermissions`.
 */
export function startMode(config?: Record<string, string>, bypass?: boolean): string {
  if (bypass || config?.bypass === 'true') return 'bypassPermissions';
  return normalizePermissionMode(config?.permissionMode) ?? 'auto';
}

/** The mode a rostered trap's next throw starts in, without --bypass. */
export function nextStartMode(cfg: Pick<Config, 'repos' | 'harness'>, entry: Pick<RosterEntry, 'repo' | 'profile'>): string {
  const configured = configPermissionMode(cfg, entry.repo);
  return startMode({ ...(configured ? { permissionMode: configured } : {}), ...entry.profile?.config });
}

/**
 * A harness command line whose first prompt redeems `ticket`. `resume`
 * reopens a saved session; without it the session is new. Model and config
 * become the harness's own flags; a config key with no flag is returned as
 * unapplied. Every start names its permission mode (see startMode).
 *
 * Codex auto is `--approve-for-me`: approvals on request, routed to Codex's
 * automatic reviewer, in the workspace-write sandbox, which is the nearest
 * thing to Claude Code's auto mode. A trap pushes, opens PRs and reports,
 * so the sandbox gets the network and `writableDirs` (lobstah's home, the
 * repo's git directory) besides the worktree.
 */
export function harnessCommand(opts: {
  harness: string;
  cwd: string;
  ticket: string;
  resume?: string;
  model?: string;
  config?: Record<string, string>;
  /** `man throw --bypass`: this start runs with no permission checks. */
  bypass?: boolean;
  /** Codex auto: directories outside the worktree the sandbox may write. */
  writableDirs?: string[];
}): StartCommand {
  const unapplied: string[] = [];
  const mode = startMode(opts.config, opts.bypass);
  if (opts.harness === 'claude') {
    const argv = ['claude'];
    if (opts.resume) argv.push('--resume', opts.resume);
    if (opts.model) argv.push('--model', opts.model);
    // No permission checks: a person's bypass.
    if (mode === 'bypassPermissions') argv.push('--dangerously-skip-permissions');
    else argv.push('--permission-mode', mode);
    for (const [key, value] of Object.entries(opts.config ?? {})) {
      if (key === 'effort') argv.push('--effort', value);
      else if (key !== 'permissionMode' && key !== 'bypass') unapplied.push(key);
    }
    argv.push(`/lobstah:trap soak --ticket ${opts.ticket}`);
    return { cwd: opts.cwd, env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, argv, unapplied, mode };
  }
  if (opts.harness === 'codex') {
    // Codex otherwise replaces the trap's custom tab title on every TUI update.
    const argv = ['codex', '-c', 'tui.terminal_title=[]'];
    if (opts.model) argv.push('-m', opts.model);
    // No approvals and no sandbox: a person's bypass.
    if (mode === 'bypassPermissions') argv.push('--dangerously-bypass-approvals-and-sandbox');
    else if (mode === 'auto') {
      argv.push('--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true');
      for (const dir of opts.writableDirs ?? []) argv.push('--add-dir', dir);
    } else if (mode !== 'default') unapplied.push(`permissionMode=${mode}`);
    for (const [key, value] of Object.entries(opts.config ?? {})) {
      if (key === 'effort') argv.push('-c', `model_reasoning_effort=${JSON.stringify(value)}`);
      else if (key !== 'permissionMode' && key !== 'bypass') unapplied.push(key);
    }
    if (opts.resume) argv.push('resume', opts.resume);
    argv.push(`$lobstah:trap soak --ticket ${opts.ticket}`);
    return { cwd: opts.cwd, env: {}, argv, unapplied, mode };
  }
  throw new Error(`no start command for harness ${opts.harness}`);
}

/**
 * Directories a Codex trap in `cwd` writes outside its worktree: lobstah's
 * home (every report and park) and the repo's git common directory (a
 * linked worktree commits there).
 */
export function trapWritableDirs(cwd: string): string[] {
  const dirs = [lobstahHome()];
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const common = git.status === 0 ? git.stdout.trim() : '';
  if (common) dirs.push(common);
  return dirs;
}

/**
 * The start command for a planned throw. Resume reopens the saved session
 * from the directory its history is keyed by; a cold start opens a new
 * session in the trap's worktree. Either way the first prompt redeems the
 * ticket, so the session signs on under the trap's own id and name.
 */
export function startCommand(row: ThrowPlanRow, entry: RosterEntry, ticket: string, bypass?: boolean): StartCommand {
  const resume = row.action === 'resume';
  const cwd = resume ? (row.resumeFrom ?? entry.worktree) : entry.worktree;
  return harnessCommand({
    harness: row.harness ?? entry.harness,
    cwd,
    ticket,
    ...(bypass ? { bypass } : {}),
    writableDirs: trapWritableDirs(cwd),
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
  /** The permission mode it started in. */
  mode: string;
  /** The registration once the trap parked. */
  registration: TrapRegistration;
  seconds: number;
}

type Launched = Pick<ThrowResult, 'trap' | 'action' | 'why' | 'checkout' | 'terminal' | 'harness' | 'command' | 'mode'> & { timeoutSecs: number };

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
  reason?: string;
  /** `man throw --bypass`, a person's choice: start with no permission checks. */
  bypass?: boolean;
}

/** Explicit CLI timeout wins; Codex gets time for plugin and model startup. */
export function startTimeoutSecs(opts: Pick<ThrowOptions, 'cfg' | 'timeoutSecs'>, harness: string): number {
  return opts.timeoutSecs ?? (harness === 'codex' ? opts.cfg.soak.codexStartSecs : DEFAULT_TRAP_START_SECS);
}

/** A throw that launched but did not come back in time. */
export class ThrowTimeoutError extends Error {}

/** The Codex process may still arrive; its reservation was retained. */
export class ThrowPendingError extends ThrowTimeoutError {}

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
  w: { trapId: string; label: string; repo?: string; retry: string; ticket: string; command: StartCommand; adapter: TerminalAdapter; started: number; launched: Omit<Launched, 'command' | 'mode' | 'timeoutSecs'> },
): Promise<ThrowResult> {
  const timeoutSecs = startTimeoutSecs(opts, w.launched.harness);
  try {
    await w.adapter.launch(w.command);
  } catch (err) {
    giveUp(w.trapId, w.label, w.repo, w.retry, w.started, err instanceof Error ? err.message : String(err));
    throw err;
  }
  const command = launchShellText({ ...w.command, argv: w.command.argv.map((a) => a.replace(w.ticket, '<ticket>')) });
  opts.onLaunch?.({ ...w.launched, command, mode: w.command.mode, timeoutSecs });
  const deadline = w.started + timeoutSecs * 1000;
  for (;;) {
    const reg = readTrap(w.trapId);
    const fresh = reg !== undefined && Date.parse(reg.signedOnAt) >= w.started - 1000;
    if (fresh && reg.firstParkedAt) {
      return {
        ...w.launched,
        command,
        mode: w.command.mode,
        harness: reg.harness,
        unapplied: w.command.unapplied,
        registration: reg,
        seconds: Math.round((Date.now() - w.started) / 1000),
      };
    }
    if (Date.now() >= deadline) {
      if (fresh) throw new (w.launched.harness === 'codex' ? ThrowPendingError : ThrowTimeoutError)(`${w.label} signed on but has not listened within ${timeoutSecs}s — it is live; check its session`);
      if (w.launched.harness === 'codex') {
        // Keep both the ticket and the fence: an already-open slow session
        // can redeem late, and retry cannot create a competing writer.
        throw new ThrowPendingError(`${w.label} has not signed on within ${timeoutSecs}s; its ticket remains valid for late sign-on — check its terminal, or withdraw with \`lobstah stow --wt ${w.trapId}\` before retrying`);
      }
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
 * trap signed on under its own id and parked. Codex timeouts retain the
 * reservation for late sign-on; other harnesses withdraw it.
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
    startSecs: startTimeoutSecs(opts, row.harness ?? entry.harness),
    by: opts.by,
    returning: { trapId: entry.trapId, worktree: entry.worktree },
    startMode: startMode(row.config, opts.bypass),
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
    command = startCommand(row, entry, ticket, opts.bypass);
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
    launched: { trap: label, action: row.action, why: row.why, checkout, terminal, harness: row.harness ?? entry.harness },
  });
}

/** The harness, model, effort, and permission mode a fresh trap starts with: the repo's harness defaults, else the global ones. */
export function freshProfile(cfg: Config, repoKey: string, harnessFlag?: string): { harness: string; model?: string; config?: Record<string, string> } {
  const repo = cfg.repos[repoKey]?.harness ?? {};
  const harness = harnessFlag ?? repo.default ?? cfg.harness.default ?? 'claude';
  const { model } = modelForHarness(harness, repo.model ?? cfg.harness.model);
  const effort = repo.effort ?? cfg.harness.effort;
  const permissionMode = configPermissionMode(cfg, repoKey);
  const config = { ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
  return { harness, ...(model ? { model } : {}), ...(Object.keys(config).length ? { config } : {}) };
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
  guardNewTraps(opts.cfg, opts.repo, 1, opts.reason);
  const profile = freshProfile(opts.cfg, opts.repo, opts.harness);
  const terminal = opts.cfg.soak.terminal ?? 'terminal';
  const adapter = resolveAdapter(opts, terminal, `a new ${opts.repo} trap`, opts.cfg.soak.terminal ? 'config' : 'default');
  const { reservation, ticket } = reserveTrap({
    repo: opts.repo,
    harness: profile.harness,
    startSecs: startTimeoutSecs(opts, profile.harness),
    by: opts.by,
    ...(opts.request ? { request: opts.request } : {}),
    creationReason: opts.reason?.trim() || `no free live or stowed ${opts.repo} trap existed at creation`,
    maxTraps: repo.traps,
    startMode: startMode(profile.config, opts.bypass),
    ...(opts.batch ? { batch: opts.batch } : {}),
  });
  const label = trapLabel(reservation);
  const command = harnessCommand({
    harness: profile.harness,
    cwd: repo.path,
    ticket,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.config ? { config: profile.config } : {}),
    ...(opts.bypass ? { bypass: true } : {}),
    writableDirs: trapWritableDirs(repo.path),
  });
  return launchAndWait(opts, {
    trapId: reservation.trapId,
    label,
    repo: opts.repo,
    retry: `lobstah man throw --new --repo ${opts.repo}`,
    ticket,
    command,
    adapter,
    started,
    launched: { trap: label, action: 'new', why: reservation.creationReason!, checkout: 'created', terminal, harness: profile.harness },
  });
}

/** One trap's outcome in a batch. */
export interface BatchResult {
  trap: string;
  result: 'resumed' | 'cold' | 'new' | 'skipped' | 'starting' | 'failed';
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
          (err: unknown) => ({ trap, result: err instanceof ThrowPendingError ? 'starting' : 'failed', why: err instanceof Error ? err.message : String(err) }) as BatchResult,
        ),
      );
    }
  } else {
    guardNewTraps(opts.cfg, opts.repo, opts.count, opts.reason);
    for (let i = 0; i < opts.count; i++) {
      jobs.push(
        throwNew({ ...each, reason: opts.reason ?? `requested batch of ${opts.count} new traps; no reusable trap at batch start`, repo: opts.repo, ...(opts.harness ? { harness: opts.harness } : {}) }).then(
          (r) => ({ trap: r.trap, result: 'new', why: r.why, seconds: r.seconds }) as BatchResult,
          (err: unknown) => ({ trap: `new ${opts.repo} trap ${i + 1}`, result: err instanceof ThrowPendingError ? 'starting' : 'failed', why: err instanceof Error ? err.message : String(err) }) as BatchResult,
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
      (count('starting') ? `, ${count('starting')} still starting` : '') +
      (failed.length ? ` — failed: ${failed.map((f) => f.trap).join(', ')}` : '') +
      (back ? ` — available: ${results.filter((r) => r.result === 'resumed' || r.result === 'cold' || r.result === 'new').map((r) => r.trap).join(', ')}` : ''),
    refId: batch,
    ...('repo' in opts ? { repo: opts.repo } : {}),
    by: opts.by,
  });
  return results;
}

/** Dispatch selection uses exactly the roster throw's resume/recreate safety checks. */
export async function trapForRepo(opts: ThrowOptions & { repo: string; harness?: string }): Promise<{ registration?: TrapRegistration; action: 'reused' | 'resumed' | 'cold' | 'new' | 'waiting'; why: string }> {
  const choice = selectRepoTrap(opts.cfg, opts.repo, opts.harness);
  if (choice.action === 'reuse') return { registration: choice.registration, action: 'reused', why: choice.why };
  if (choice.action === 'wait') return { action: 'waiting', why: choice.why };
  if (choice.action === 'return') {
    const r = await throwTrap({ ...opts, address: `wt:${choice.row.trapId}` });
    return { registration: r.registration, action: r.action === 'resume' ? 'resumed' : 'cold', why: choice.why };
  }
  // Capacity is checked again immediately before reservation in throwNew.
  const count = repoTrapCount(opts.cfg, opts.repo);
  if (count.limit !== undefined && count.used >= count.limit) return { action: 'waiting', why: `${count.text}; waiting for a free trap` };
  const r = await throwNew({ ...opts, reason: choice.why });
  return { registration: r.registration, action: 'new', why: choice.why };
}

/** What `man throw` prints once the terminal opened. */
export function launchedText(launched: Launched, timeoutSecs = launched.timeoutSecs): string {
  return toonKV({
    trap: launched.trap,
    start: launched.action,
    why: launched.why,
    checkout: launched.checkout,
    terminal: terminalAppName(launched.terminal),
    mode: launched.mode,
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
      mode: result.mode,
      ...(result.unapplied.length ? { unapplied: `profile config ${result.unapplied.join(', ')} has no ${result.harness} flag; not applied` } : {}),
    }),
    toonHelp([`lobstah dispatch --repo <key> --for ${address} --brief <file.md>   (address work to it)`]),
  ].join('\n');
}

/** A batch's per-trap results. */
export function batchText(results: BatchResult[]): string {
  return toonTable('throw', results.map((r) => ({ trap: r.trap, result: r.result, seconds: r.seconds ?? '', why: r.why })), ['trap', 'result', 'seconds', 'why']);
}
