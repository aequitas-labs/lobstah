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
import { toonHelp, toonKV } from '@lobstah/core';

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
 * The start command for a planned throw. Resume reopens the saved session
 * from the directory its history is keyed by; a cold start opens a new
 * session in the trap's worktree. Either way the first prompt redeems the
 * ticket, so the session signs on under the trap's own id and name.
 */
export function startCommand(row: ThrowPlanRow, entry: RosterEntry, ticket: string): StartCommand {
  const harness = row.harness ?? entry.harness;
  const resume = row.action === 'resume';
  const cwd = resume ? (row.resumeFrom ?? entry.worktree) : entry.worktree;
  const config = { ...row.config };
  const unapplied: string[] = [];
  if (harness === 'claude') {
    const argv = ['claude'];
    if (resume) argv.push('--resume', entry.sessionId);
    if (row.model) argv.push('--model', row.model);
    for (const [key, value] of Object.entries(config)) {
      if (key === 'effort') argv.push('--effort', value);
      else if (key === 'permissionMode') argv.push('--permission-mode', value);
      else unapplied.push(key);
    }
    argv.push(`/lobstah:trap soak --ticket ${ticket}`);
    return { cwd, env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, argv, unapplied };
  }
  if (harness === 'codex') {
    const argv = ['codex'];
    if (row.model) argv.push('-m', row.model);
    for (const [key, value] of Object.entries(config)) {
      if (key === 'effort') argv.push('-c', `model_reasoning_effort=${JSON.stringify(value)}`);
      else unapplied.push(key);
    }
    if (resume) argv.push('resume', entry.sessionId);
    argv.push(`$lobstah:trap soak --ticket ${ticket}`);
    return { cwd, env: {}, argv, unapplied };
  }
  throw new Error(`no start command for harness ${harness}`);
}

export interface ThrowResult {
  trap: string;
  action: 'resume' | 'cold';
  why: string;
  checkout: 'kept' | 'recreated';
  terminal: TerminalApp;
  harness: string;
  command: string;
  unapplied: string[];
  /** The registration once the trap parked. */
  registration: TrapRegistration;
  seconds: number;
}

/** A throw that launched but did not come back in time. */
export class ThrowTimeoutError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `lobstah man throw <name>`: bring one rostered trap back and wait until it
 * listens. The plan decides resume or cold start and whether the checkout is
 * kept or recreated; a same-id reservation fences a second launch; the
 * terminal adapter opens the session; the throw returns only after the
 * trap signed on under its own id and parked. On a timeout the reservation
 * is withdrawn, so a late session cannot take the trap, and the roster stays
 * as it was.
 */
export async function throwTrap(opts: {
  address: string;
  cfg: Config;
  by?: string;
  timeoutSecs?: number;
  adapter?: (app: TerminalApp) => TerminalAdapter;
  pollMs?: number;
  onLaunch?: (result: Pick<ThrowResult, 'trap' | 'action' | 'why' | 'checkout' | 'terminal' | 'command'>) => void;
}): Promise<ThrowResult> {
  const started = Date.now();
  const timeoutSecs = opts.timeoutSecs ?? DEFAULT_TRAP_START_SECS;
  const [row] = planThrow(opts.cfg, { names: [opts.address] });
  const entry = rosterByAddress(opts.address);
  if (!row || !entry) throw new Error(`no roster record for ${opts.address} — \`lobstah man roster\` lists the traps a throw can bring back`);
  const label = trapLabel(entry);
  if (row.action === 'skip') {
    throw new TrapStartingError(`not throwing ${label}: ${row.why}`);
  }
  if (row.action === 'unresolved') throw new Error(`cannot throw ${label}: ${row.why}`);
  const terminal = row.terminal ?? 'terminal';
  if (!isTerminalApp(terminal)) {
    throw new Error(`cannot throw ${label}: terminal "${String(terminal)}" (${row.terminalFrom}) is not supported — use ${TERMINAL_APPS.join(' or ')}`);
  }
  const adapter = (opts.adapter ?? macTerminalAdapter)(terminal);
  const repo = opts.cfg.repos[entry.repo!]!;

  // The fence: one reservation per trap, created exclusively.
  const { ticket } = reserveTrap({
    repo: entry.repo!,
    harness: row.harness,
    name: entry.name,
    startSecs: timeoutSecs,
    by: opts.by,
    returning: { trapId: entry.trapId, worktree: entry.worktree },
  });
  const giveUp = (reason: string): void => {
    if (!readReservation(entry.trapId)) return;
    dropReservation(entry.trapId);
    postNotice({
      kind: 'trap-start-failed',
      text: `trap ${label} did not come back: ${reason}. Its reservation is withdrawn; the roster still lists it — \`lobstah man throw ${entry.name}\` tries again.`,
      refId: entry.trapId,
      repo: entry.repo,
      dedupeKey: `throw-failed-${entry.trapId}-${started}`,
    });
  };

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
    await adapter.launch(command);
  } catch (err) {
    giveUp(err instanceof Error ? err.message : String(err));
    throw err;
  }
  const shown = launchShellText({ ...command, argv: command.argv.map((a) => a.replace(ticket, '<ticket>')) });
  opts.onLaunch?.({ trap: label, action: row.action, why: row.why, checkout, terminal, command: shown });

  const deadline = started + timeoutSecs * 1000;
  for (;;) {
    const reg = readTrap(entry.trapId);
    if (reg?.firstParkedAt && Date.parse(reg.signedOnAt) >= started - 1000) {
      return {
        trap: label,
        action: row.action,
        why: row.why,
        checkout,
        terminal,
        harness: reg.harness,
        command: shown,
        unapplied: command.unapplied,
        registration: reg,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    }
    if (Date.now() >= deadline) {
      if (reg && Date.parse(reg.signedOnAt) >= started - 1000) {
        throw new ThrowTimeoutError(`${label} signed on but has not listened within ${timeoutSecs}s — it is live; check its session`);
      }
      giveUp(`no sign-on within ${timeoutSecs}s`);
      throw new ThrowTimeoutError(`${label} did not sign on within ${timeoutSecs}s; its reservation is withdrawn and the roster is unchanged`);
    }
    await sleep(opts.pollMs ?? 500);
  }
}

/** What `man throw` prints once the terminal opened. */
export function launchedText(launched: Pick<ThrowResult, 'trap' | 'action' | 'why' | 'checkout' | 'terminal' | 'command'>, timeoutSecs = DEFAULT_TRAP_START_SECS): string {
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
