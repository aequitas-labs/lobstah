import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';
import type { Lane } from './types.js';
import { laneDirs } from './paths.js';
import { readEvidence } from './evidence.js';
import { storedDescriptor } from './queue.js';
import { readTrap } from './soak.js';
import type { SessionClaim } from './soak.js';
import { readStatusLog } from './status.js';

/**
 * Which harness owns a dispatch's session — the one resolver behind a
 * follow-up's resume, the daemon's restart resume, `lobstah swap`, and
 * pickup review rounds (which are follow-ups).
 *
 * A session only resumes under the harness that wrote it: a Codex thread id
 * handed to Claude Code is "No conversation found", and the reverse fails
 * the same way. The descriptor's `harness` records what was *asked*, not
 * what ran — a trap claims unaddressed bait with whatever harness it is —
 * so it is the last resort, not the first.
 *
 * Precedence:
 *   1. evidence `harness` — stamped on first run by the runner (the
 *      adapter's) and by a trap's claim (the trap's);
 *   2. the trap that claimed it — `claim.json`, else the registration named
 *      by the evidence's `deliveredTo`;
 *   3. the session id's UUID version (backfill for evidence written before
 *      `harness` existed): v7 → codex, v4 → claude;
 *   4. the dispatch's own descriptor, resolved through config defaults.
 */

export type SessionHarnessSource = 'evidence' | 'trap' | 'session-id' | 'descriptor';

export interface SessionHarness {
  sessionId?: string;
  harness?: string;
  source?: SessionHarnessSource;
  lane?: Lane;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The harness a session id's format implies: v7 → codex, v4 → claude, else
 * undefined. Codex thread ids are UUIDv7 (time-ordered); Claude Code session
 * ids are UUIDv4 (random).
 */
export function harnessFromSessionId(sessionId: string | undefined): 'claude' | 'codex' | undefined {
  const version = sessionId ? UUID.exec(sessionId)?.[1] : undefined;
  return version === '7' ? 'codex' : version === '4' ? 'claude' : undefined;
}

/** `claim.json` wherever the dispatch lives now — active, or moved to done with it. */
function claimOf(id: string, lane: Lane): SessionClaim | undefined {
  const dirs = laneDirs(lane);
  for (const dir of [dirs.active, dirs.done]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, id, 'claim.json'), 'utf8')) as SessionClaim;
    } catch {
      // not in this bucket
    }
  }
  return undefined;
}

/** The lane a dispatch lives in, judged by whichever record exists. */
function laneOf(id: string): Lane | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    if (storedDescriptor(id, lane) || readEvidence(id, lane).sessionId) return lane;
  }
  return undefined;
}

export function resolveSessionHarness(id: string, cfg?: Config, laneHint?: Lane): SessionHarness {
  const lane = laneHint ?? laneOf(id);
  if (!lane) return {};
  const ev = readEvidence(id, lane);
  const sessionId = ev.sessionId;
  const out = (harness: string | undefined, source: SessionHarnessSource): SessionHarness => ({
    sessionId,
    harness,
    source,
    lane,
  });
  if (ev.harness) return out(ev.harness, 'evidence');
  const claim = claimOf(id, lane);
  if (claim?.harness) return out(claim.harness, 'trap');
  if (ev.deliveredTo?.startsWith('wt:')) {
    const reg = readTrap(ev.deliveredTo.slice('wt:'.length));
    if (reg?.harness) return out(reg.harness, 'trap');
  }
  const byId = harnessFromSessionId(sessionId);
  if (byId) return out(byId, 'session-id');
  const d = storedDescriptor(id, lane);
  const repo = d && cfg?.repos[d.repo];
  const fromDescriptor = d?.harness ?? repo?.harness?.default ?? cfg?.harness.default;
  if (fromDescriptor) return out(fromDescriptor, 'descriptor');
  return { sessionId, lane };
}

/**
 * Errors that mean "this session cannot be resumed here" — gone, culled, or
 * written by another harness — as opposed to a real failure of the work.
 * Claude Code: "No conversation found with session ID: …"; Codex: "no
 * rollout found for thread id …" / thread-not-found variants.
 */
const UNRESUMABLE =
  /no conversation found|no rollout found|thread\/resume failed|(session|thread|conversation)( id)?[^.\n]{0,80}\b(not found|does not exist|unknown|invalid)|(could not|cannot|failed to|unable to) (find|load|resume)[^.\n]{0,40}\b(session|thread|conversation)/i;

export function isUnresumable(error: string | undefined): boolean {
  return error !== undefined && UNRESUMABLE.test(error);
}

/**
 * The auto-generated progress note for a cold start that replaces a resume
 * (swap, follow-up swap, resume fallback): the conversation cannot come
 * along, so the next session gets the worktree state instead. With `trunk`,
 * commits are the branch's own (`origin/<trunk>..HEAD`); without, the last 15.
 */
export function worktreeProgress(worktree: string | undefined, trunk?: string): string {
  if (!worktree || !fs.existsSync(worktree)) return 'No worktree progress recorded.';
  const git = (...a: string[]) => spawnSync('git', a, { cwd: worktree, encoding: 'utf8' }).stdout?.trim() ?? '';
  const commits = trunk ? git('log', '--oneline', `origin/${trunk}..HEAD`) : git('log', '--oneline', '-15');
  const status = git('status', '--short');
  return `Commits so far:
${commits || '(none)'}

Uncommitted changes:
${status || '(clean)'}`;
}

/** What an earlier dispatch left behind, for a follow-up that cannot resume it. */
export function originProgress(originId: string, lane: Lane): string {
  const ev = readEvidence(originId, lane);
  const last = readStatusLog(originId, lane).at(-1);
  const lines = [`The earlier dispatch ${originId} left:`];
  if (ev.branch) lines.push(`- branch: ${ev.branch}`);
  if (ev.prUrl) lines.push(`- PR: ${ev.prUrl}`);
  if (last) lines.push(`- last status: ${last.verb}${last.note ? ` — ${last.note}` : ''}`);
  if (ev.commits?.length) lines.push('- commits:', ...ev.commits.map((c) => `    ${c}`));
  if (lines.length === 1) lines.push('- (no recorded branch, PR, or commits)');
  return lines.join('\n');
}

/** Wrap a progress note as the handoff a cold replacement session reads. */
export function handoffNote(fromHarness: string, progress: string, why?: string): string {
  return (
    `You are taking over this dispatch from a previous agent session (harness: ${fromHarness}). ` +
    `Its conversation is not available${why ? ` (${why})` : ''} — the state below is the ground truth. ` +
    `Review it, then continue the brief from where it stops.

${progress}`
  );
}

/** `$CODEX_HOME`, else `~/.codex` — where Codex keeps its rollouts. */
function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** The rollout file Codex wrote for this thread, if one exists locally. */
export function codexRolloutFile(threadId: string, home: string = codexHome()): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix)) return path.join(dir, e.name);
    }
    if (depth === 0) return undefined;
    // Newest first: the date directories sort lexically.
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const hit = walk(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return undefined;
  };
  // sessions/YYYY/MM/DD/rollout-…-<id>.jsonl; archived_sessions is flat.
  return walk(path.join(home, 'sessions'), 3) ?? walk(path.join(home, 'archived_sessions'), 0);
}

/**
 * Whether a Codex thread was written by the Codex desktop app rather than
 * the CLI — its rollout's `session_meta.originator` names the desktop app
 * ("Codex Desktop", "codex_work_desktop"); a CLI run says `codex_exec` or
 * `codex_sdk_ts`. `codex exec resume` has been observed to refuse desktop
 * threads ("thread/resume failed: no rollout found for thread id …", e2de5dd7),
 * so a desktop thread is never handed to the CLI. Returns the originator, or
 * undefined when the thread is not a known desktop thread (a CLI rollout, or
 * no local rollout at all — then the resume is still attempted).
 */
export function codexDesktopThread(threadId: string, home: string = codexHome()): string | undefined {
  const file = codexRolloutFile(threadId, home);
  if (!file) return undefined;
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const originator = /"originator"\s*:\s*"([^"]*)"/.exec(head)?.[1];
  return originator && /desktop/i.test(originator) ? originator : undefined;
}

/** The status phrasing for a desktop thread the CLI will not resume. */
export const CODEX_DESKTOP_THREAD = 'Codex desktop thread; not resumable from the CLI';
