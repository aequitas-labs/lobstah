import * as fs from 'node:fs';
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
  /no conversation found|no rollout found|(session|thread|conversation)( id)?[^.\n]{0,80}\b(not found|does not exist|unknown|invalid)|(could not|cannot|failed to|unable to) (find|load|resume)[^.\n]{0,40}\b(session|thread|conversation)/i;

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
