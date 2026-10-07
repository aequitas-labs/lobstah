import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from './config.js';
import { lobstahHome } from './paths.js';
import { listRoster, rosterByAddress, terminalAppName, type RosterEntry, type TerminalApp } from './roster.js';
import { listTraps, readTrap, readTrapAnchor, trapByAddress, trapLastSeen, type TrapRegistration } from './soak.js';
import { readReservation } from './trap-start.js';
import { unhandledTrapMessages } from './inbox.js';
import { gitCommonDir, protectedRevision, trapRef } from './worktree-safety.js';
import { codexDesktopThread, codexRolloutFile } from './resume.js';

/**
 * `man throw --plan`: what a throw would do for each selected trap, read
 * from the roster. It launches nothing and writes nothing.
 *
 *   resume      the harness reopens the trap's saved session
 *   cold        a new session in the same trap (same name, id, checkout); `why` says why
 *   skip        nothing to do: the trap is live or starting
 *   unresolved  a throw would refuse until a person resolves `why`
 */
export type ThrowAction = 'resume' | 'cold' | 'skip' | 'unresolved';

export interface ThrowPlanRow {
  trapId: string;
  name: string;
  repo?: string;
  action: ThrowAction;
  why: string;
  harness?: string;
  harnessFrom?: 'profile' | 'last sign-on';
  model?: string;
  config?: Record<string, string>;
  terminal?: TerminalApp;
  terminalFrom?: 'profile' | 'config' | 'last sign-on' | 'default';
  /** kept: adopt the checkout as it is; recreate: add it back at the protected revision. */
  checkout?: 'kept' | 'recreate';
  worktree?: string;
  branch?: string;
  revision?: string;
  sessionId?: string;
  /** resume: the directory the harness must start in to find the session (Claude keys transcripts by it). */
  resumeFrom?: string;
  /** Unread messages held for the trap. */
  held?: number;
}

export interface ThrowSelection {
  /** Names or addresses; each gets a row, known or not. */
  names?: string[];
  /** Every eligible trap in scope. */
  all?: boolean;
  /** Narrow to one repo (alone, it means every eligible trap of that repo). */
  repo?: string;
}

export interface ThrowPlanOptions {
  /** The grounds' repos; undefined = every repo. Applies to --all and --repo. */
  repos?: readonly string[];
  now?: number;
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeHome?: string;
  /** `$CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
}

const short = (s: string): string => s.slice(0, 8);

/** Claude Code keeps a session under its starting directory, munged to '-'. */
function claudeProjectDir(home: string, cwd: string): string {
  return path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
}

function claudeTranscript(home: string, sessionId: string, cwds: string[]): { found: 'here'; from: string } | { found: 'elsewhere' } | undefined {
  for (const cwd of cwds) {
    if (fs.existsSync(path.join(claudeProjectDir(home, cwd), `${sessionId}.jsonl`))) return { found: 'here', from: cwd };
  }
  try {
    for (const dir of fs.readdirSync(path.join(home, 'projects'))) {
      if (fs.existsSync(path.join(home, 'projects', dir, `${sessionId}.jsonl`))) return { found: 'elsewhere' };
    }
  } catch {
    // no projects directory
  }
  return undefined;
}

/** The app surface a session ran in, when it was not a terminal CLI. */
function appSurface(entry: RosterEntry): string | undefined {
  if (entry.link?.startsWith('claude://')) return "the Claude desktop app's Code tab";
  if (entry.link?.startsWith('vscode://') || entry.window?.entrypoint === 'claude-vscode') return 'the VS Code extension';
  if (entry.link?.startsWith('codex://') || entry.window?.bundleId === 'com.openai.codex') return 'the Codex app';
  if (entry.window?.entrypoint === 'claude-desktop') return "the Claude desktop app's Code tab";
  return undefined;
}

function terminalFor(entry: RosterEntry, cfg: Config): Pick<ThrowPlanRow, 'terminal' | 'terminalFrom'> {
  if (entry.profile?.terminal) return { terminal: entry.profile.terminal, terminalFrom: 'profile' };
  if (cfg.soak.terminal) return { terminal: cfg.soak.terminal, terminalFrom: 'config' };
  const program = entry.window?.termProgram;
  if (program === 'iTerm.app') return { terminal: 'iterm', terminalFrom: 'last sign-on' };
  if (program === 'Apple_Terminal') return { terminal: 'terminal', terminalFrom: 'last sign-on' };
  return { terminal: 'terminal', terminalFrom: 'default' };
}

/** Whether the start resumes the saved session or starts cold, and why. */
function startMode(
  entry: RosterEntry,
  harness: string,
  cwds: string[],
  opts: ThrowPlanOptions,
): { action: 'resume' | 'cold'; why: string; from?: string } {
  const sid = short(entry.sessionId);
  if (harness !== entry.harness) {
    return { action: 'cold', why: `profile harness ${harness} differs from the ${entry.harness} session ${sid}; a session resumes only under the harness that wrote it` };
  }
  const surface = appSurface(entry);
  if (surface) return { action: 'cold', why: `session ${sid} ran in ${surface}; a terminal does not resume app sessions` };
  if (harness === 'claude') {
    const home = opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const found = claudeTranscript(home, entry.sessionId, cwds);
    if (found?.found === 'here') return { action: 'resume', why: `claude --resume ${sid} from ${found.from}`, from: found.from };
    if (found) return { action: 'cold', why: `the transcript of session ${sid} is under a directory this trap does not know` };
    return { action: 'cold', why: `no saved Claude history for session ${sid}` };
  }
  if (harness === 'codex') {
    const home = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    if (!codexRolloutFile(entry.sessionId, home)) return { action: 'cold', why: `no saved Codex rollout for thread ${sid}` };
    const desktop = codexDesktopThread(entry.sessionId, home);
    if (desktop) return { action: 'cold', why: `thread ${sid} was written by ${desktop}; the CLI does not resume desktop threads` };
    return { action: 'resume', why: `codex resume ${sid}`, from: entry.worktree };
  }
  return { action: 'cold', why: `no resume support for harness ${harness}` };
}

/** One roster record's plan. */
function planEntry(entry: RosterEntry, cfg: Config, opts: ThrowPlanOptions): ThrowPlanRow {
  const now = opts.now ?? Date.now();
  const harness = entry.profile?.harness ?? entry.harness;
  const held = unhandledTrapMessages(entry.trapId).length;
  const row: ThrowPlanRow = {
    trapId: entry.trapId,
    name: entry.name,
    ...(entry.repo ? { repo: entry.repo } : {}),
    action: 'unresolved',
    why: '',
    ...(harness ? { harness, harnessFrom: entry.profile?.harness ? 'profile' : 'last sign-on' } : {}),
    ...((entry.profile?.model ?? entry.model) ? { model: entry.profile?.model ?? entry.model } : {}),
    ...(entry.config || entry.profile?.config ? { config: { ...entry.config, ...entry.profile?.config } } : {}),
    ...terminalFor(entry, cfg),
    worktree: entry.worktree,
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.head ? { revision: entry.head } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(held ? { held } : {}),
  };
  const done = (action: ThrowAction, why: string): ThrowPlanRow => ({ ...row, action, why });

  const reg = readTrap(entry.trapId);
  if (reg) {
    const fresh = now - trapLastSeen(reg) <= cfg.soak.ttlSecs * 1000;
    return fresh
      ? done('skip', `live: session ${short(reg.sessionId)} mans it`)
      : done('skip', `registered but quiet: the ghost sweep releases it before a throw can`);
  }
  const reservation = readReservation(entry.trapId);
  if (reservation) return done('skip', reservation.failedAt ? `reserved; start failed: ${reservation.reason ?? 'unknown'}` : `starting: reserved, sign-on due by ${reservation.deadline}`);

  if (!entry.repo) return done('unresolved', 'no repo recorded: the trap only took addressed work');
  const repo = cfg.repos[entry.repo];
  if (!repo) return done('unresolved', `repo ${entry.repo} is no longer configured`);
  if (!entry.harness || !entry.sessionId) return done('unresolved', 'incomplete record: no harness or session recorded');
  const configured = gitCommonDir(repo.path);
  if (entry.gitDir && configured && configured !== entry.gitDir) {
    return done('unresolved', `repo ${entry.repo} now points at another repository (${configured}, recorded ${entry.gitDir})`);
  }

  // The checkout: adopt it as it is, or add it back at the protected revision.
  let checkout: 'kept' | 'recreate';
  if (fs.existsSync(entry.worktree)) {
    const anchored = readTrapAnchor(entry.worktree)?.trapId;
    if (anchored !== entry.trapId) {
      return done('unresolved', anchored ? `${entry.worktree} now anchors wt:${anchored}` : `${entry.worktree} exists but anchors no trap`);
    }
    checkout = 'kept';
  } else {
    const gitDir = entry.gitDir ?? configured;
    const kept = gitDir ? protectedRevision(gitDir, entry.trapId) : undefined;
    if (!kept) return done('unresolved', `worktree ${entry.worktree} is gone and no protected ref keeps its revision`);
    row.revision = kept;
    checkout = 'recreate';
  }

  const mode = startMode(entry, harness, [entry.worktree, repo.path], opts);
  const where = checkout === 'kept' ? 'kept checkout' : `checkout recreated from ${trapRef(entry.trapId)}`;
  return { ...done(mode.action, `${mode.why}; ${where}`), checkout, ...(mode.from ? { resumeFrom: mode.from } : {}) };
}

/** A registration with no roster record yet (signed on before the roster existed). */
function liveRow(reg: TrapRegistration, cfg: Config, now: number): ThrowPlanRow {
  const fresh = now - trapLastSeen(reg) <= cfg.soak.ttlSecs * 1000;
  return {
    trapId: reg.trapId,
    name: reg.name ?? `wt:${reg.trapId}`,
    ...(reg.repo ? { repo: reg.repo } : {}),
    action: 'skip',
    why: fresh ? `live: session ${short(reg.sessionId)} mans it` : 'registered but quiet: the ghost sweep releases it before a throw can',
    harness: reg.harness,
    harnessFrom: 'last sign-on',
    worktree: reg.worktree,
    sessionId: reg.sessionId,
  };
}

/** Worktrees under lobstah's root that anchor a trap the roster does not know (stowed before it existed). */
function unrecordedAnchors(known: Set<string>): ThrowPlanRow[] {
  const root = path.join(lobstahHome(), 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  return names.flatMap((dir) => {
    const worktree = path.join(root, dir);
    const anchor = readTrapAnchor(worktree);
    if (!anchor || known.has(anchor.trapId)) return [];
    known.add(anchor.trapId);
    return [{
      trapId: anchor.trapId,
      name: anchor.name ?? `wt:${anchor.trapId}`,
      ...(anchor.repo ? { repo: anchor.repo } : {}),
      action: 'unresolved' as const,
      why: 'no roster record (stowed before the roster existed): its harness is unknown — soak in it once to record it',
      worktree,
      ...(anchor.sessionId ? { sessionId: anchor.sessionId } : {}),
    }];
  });
}

/** The plan for a selection. Read-only. */
export function planThrow(cfg: Config, selection: ThrowSelection, opts: ThrowPlanOptions = {}): ThrowPlanRow[] {
  const now = opts.now ?? Date.now();
  if (selection.names?.length) {
    return selection.names.map((address) => {
      const entry = rosterByAddress(address);
      if (entry) return planEntry(entry, cfg, opts);
      const reg = trapByAddress(address);
      if (reg) return liveRow(reg, cfg, now);
      const bare = address.replace(/^wt:/, '');
      return { trapId: bare, name: bare, action: 'unresolved' as const, why: `no roster record for ${address}` };
    });
  }
  const inScope = (repo: string | undefined): boolean =>
    repo !== undefined && (opts.repos === undefined || opts.repos.includes(repo)) && (selection.repo === undefined || repo === selection.repo);
  const entries = listRoster().filter((e) => inScope(e.repo));
  const known = new Set(listRoster().map((e) => e.trapId));
  const rows = entries.map((e) => planEntry(e, cfg, opts));
  for (const reg of listTraps()) {
    if (known.has(reg.trapId)) continue;
    known.add(reg.trapId);
    if (inScope(reg.repo)) rows.push(liveRow(reg, cfg, now));
  }
  rows.push(...unrecordedAnchors(known).filter((r) => inScope(r.repo)));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The terminal column: app and where the choice came from. */
export function throwTerminalText(row: Pick<ThrowPlanRow, 'terminal' | 'terminalFrom'>): string | undefined {
  return row.terminal ? `${terminalAppName(row.terminal)} (${row.terminalFrom})` : undefined;
}
