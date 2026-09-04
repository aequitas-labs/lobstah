import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Descriptor, Lane } from './types.js';
import { laneDirs, soakingDir } from './paths.js';
import { cancelRequested, claimNext, complete, requeue } from './queue.js';
import { appendStatus, readStatusLog } from './status.js';
import { mergeEvidence } from './evidence.js';
import { TERMINAL_VERBS } from './types.js';

/**
 * A soaking trap: a live interactive session that volunteered to take bait.
 * The registration is written by `lobstah soak`, heartbeated by the session's
 * Stop-hook park, and removed by `lobstah stow` or the ghost-trap sweep.
 */
export interface SoakRegistration {
  sessionId: string;
  harness: string;
  /** Config repo key this trap fishes for; without one it only takes addressed bait. */
  repo?: string;
  /** Canonical worktree root the session works in — never a primary checkout. */
  worktree: string;
  cwd: string;
  /** Stow after the first catch instead of re-parking. */
  one?: boolean;
  signedOnAt: string;
  heartbeatAt: string;
  /** The active dispatch this session currently works, if any. */
  claimed?: string;
}

/** Claim marker for a session-claimed active dispatch (`claim.json`). */
export interface SessionClaim {
  by: string; // session:<id>
  harness: string;
  worktree: string;
  at: string;
}

function regPath(sessionId: string): string {
  return path.join(soakingDir(), `${sessionId}.json`);
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function signOnSoak(
  reg: Omit<SoakRegistration, 'signedOnAt' | 'heartbeatAt'>,
): SoakRegistration {
  const now = new Date().toISOString();
  const prior = readSoak(reg.sessionId);
  const full: SoakRegistration = {
    ...reg,
    signedOnAt: prior?.signedOnAt ?? now,
    heartbeatAt: now,
    claimed: prior?.claimed,
  };
  atomicWrite(regPath(reg.sessionId), JSON.stringify(full, null, 2));
  return full;
}

export function readSoak(sessionId: string): SoakRegistration | undefined {
  try {
    return JSON.parse(fs.readFileSync(regPath(sessionId), 'utf8')) as SoakRegistration;
  } catch {
    return undefined;
  }
}

export function listSoaking(): SoakRegistration[] {
  try {
    return fs
      .readdirSync(soakingDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(soakingDir(), f), 'utf8')) as SoakRegistration);
  } catch {
    return [];
  }
}

export function stowSoak(sessionId: string): SoakRegistration | undefined {
  const reg = readSoak(sessionId);
  if (!reg) return undefined;
  fs.rmSync(regPath(sessionId), { force: true });
  return reg;
}

export function heartbeatSoak(sessionId: string, patch: Partial<SoakRegistration> = {}): SoakRegistration | undefined {
  const reg = readSoak(sessionId);
  if (!reg) return undefined;
  const next = { ...reg, ...patch, heartbeatAt: new Date().toISOString() };
  atomicWrite(regPath(sessionId), JSON.stringify(next, null, 2));
  return next;
}

function claimPath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).active, id, 'claim.json');
}

export function readSessionClaim(id: string, lane: Lane): SessionClaim | undefined {
  try {
    return JSON.parse(fs.readFileSync(claimPath(id, lane), 'utf8')) as SessionClaim;
  } catch {
    return undefined;
  }
}

/** The session id a descriptor is addressed to, if it targets one. */
export function addressedSession(d: Descriptor): string | undefined {
  return d.for?.startsWith('session:') ? d.for.slice('session:'.length) : undefined;
}

/** Whether the registration's claimed catch is still active and non-terminal. */
export function hasOpenCatch(reg: SoakRegistration): boolean {
  if (!reg.claimed) return false;
  if (!fs.existsSync(path.join(laneDirs('work').active, reg.claimed))) return false;
  const last = readStatusLog(reg.claimed, 'work').at(-1)?.verb;
  return last === undefined || !TERMINAL_VERBS.includes(last);
}

/**
 * Let go of an open catch: a cancelled one finalizes as failed, anything else
 * goes back to the queue for the daemon to work. Used by `stow` and the
 * ghost-trap sweep — the two paths where a claimant stops answering for its
 * claim.
 */
export function releaseCatch(reg: SoakRegistration): { requeued?: string; finalized?: string } {
  if (!hasOpenCatch(reg)) return {};
  const id = reg.claimed!;
  fs.rmSync(path.join(laneDirs('work').active, id, 'claim.json'), { force: true });
  if (cancelRequested(id, 'work')) {
    appendStatus(id, 'work', 'failed', 'cancelled by request; claimant gone, work preserved');
    complete(id, 'work');
    return { finalized: id };
  }
  requeue(id, 'work');
  return { requeued: id };
}

/**
 * One cast of the line for a soaking session: claim the best matching bait
 * from the work queue, or nothing. Addressed bait outranks the general queue;
 * unaddressed bait needs a repo match; a trap already working a catch takes
 * nothing more (one active item per worktree, enforced here).
 */
export function claimBait(reg: SoakRegistration): { id: string; descriptor: Descriptor } | null {
  if (hasOpenCatch(reg)) return null;
  const mine = `session:${reg.sessionId}`;
  const takeable = (d: Descriptor): boolean => {
    if (d.for === mine) return true;
    if (d.for !== undefined) return false;
    return reg.repo !== undefined && d.repo === reg.repo;
  };
  // Two passes so addressed bait wins even when it queued later.
  for (const pass of [(d: Descriptor) => d.for === mine, takeable]) {
    const id = claimNext('work', (d) => !pass(d));
    if (!id) continue;
    const descriptor = JSON.parse(
      fs.readFileSync(path.join(laneDirs('work').active, id, 'descriptor.json'), 'utf8'),
    ) as Descriptor;
    const claim: SessionClaim = { by: mine, harness: reg.harness, worktree: reg.worktree, at: new Date().toISOString() };
    atomicWrite(claimPath(id, 'work'), JSON.stringify(claim, null, 2));
    mergeEvidence(id, 'work', { sessionId: reg.sessionId });
    heartbeatSoak(reg.sessionId, { claimed: id });
    return { id, descriptor };
  }
  return null;
}

const msOf = (iso: string): number => Date.parse(iso) || 0;

/** Heartbeat fresh enough that the daemon should leave matching bait alone. */
export function soakReady(reg: SoakRegistration, deferMs: number, now = Date.now()): boolean {
  return now - msOf(reg.heartbeatAt) <= deferMs && !hasOpenCatch(reg);
}

/**
 * The daemon's skip predicate: leave bait addressed to any registered trap,
 * and defer unaddressed bait briefly to a trap that is parked right now
 * (fresh heartbeat). A stale trap loses the deference; a swept one loses the
 * address too.
 */
export function soakSkip(soaking: SoakRegistration[], deferMs: number, now = Date.now()): (d: Descriptor) => boolean {
  return (d) => {
    const to = addressedSession(d);
    if (to !== undefined) return soaking.some((r) => r.sessionId === to);
    return soaking.some((r) => r.repo === d.repo && soakReady(r, deferMs, now));
  };
}

export interface GhostSweepAction {
  sessionId: string;
  /** The abandoned catch's id — requeued, or finalized as failed when it was cancelled. */
  requeued?: string;
}

/**
 * Ghost traps — registrations whose heartbeat went stale past the TTL — get
 * hauled out: an open claim goes back to the queue for the daemon to work,
 * and the registration is removed. A session mid-catch proves liveness
 * through its status reports, so a fresh report keeps the trap out of the
 * sweep even when the park heartbeat lapsed.
 */
export function sweepGhostTraps(ttlMs: number, now = Date.now()): GhostSweepAction[] {
  const actions: GhostSweepAction[] = [];
  for (const reg of listSoaking()) {
    if (now - msOf(reg.heartbeatAt) <= ttlMs) continue;
    if (hasOpenCatch(reg)) {
      const lastReport = readStatusLog(reg.claimed!, 'work').at(-1)?.at;
      if (lastReport && now - msOf(lastReport) <= ttlMs) continue; // working, just not parked
      const released = releaseCatch(reg);
      actions.push({ sessionId: reg.sessionId, requeued: released.requeued ?? released.finalized });
    } else {
      actions.push({ sessionId: reg.sessionId });
    }
    fs.rmSync(regPath(reg.sessionId), { force: true });
  }
  return actions;
}

/**
 * The brief a soaking session receives with its claimed work. Deliberately
 * plain language: the lobsterman's surfaces are on theme, but a worker gets
 * task instructions, never metaphor to decode.
 */
export function baitBrief(id: string, d: Descriptor): string {
  return [
    `You are a lobstah worker session and have been assigned dispatch ${id}.`,
    '',
    'Do the work in THIS worktree on a fresh branch (branch first, never on the checked-out state directly).',
    `Report progress with \`lobstah report ${id} working "<note>"\` at milestones, check \`lobstah inbox ${id}\` at natural checkpoints, and finish with \`lobstah report ${id} done "<note>" [--pr <url>]\` (or \`failed\`).`,
    'The task:',
    '',
    d.brief,
  ].join('\n');
}
