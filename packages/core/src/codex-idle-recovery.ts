import fs from 'node:fs';
import path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { readSessionClaim, type TrapRegistration } from './soak.js';
import { laneOf } from './worktrees.js';

interface IdleWake { sessionId: string; dispatchId: string; claimAt: string; at: number }
const fileFor = (trap: TrapRegistration) => path.join(lobstahHome(), 'codex-idle-wakes', `${encodeURIComponent(trap.trapId)}.json`);

/** One automatic recovery per claim and session, surviving daemon restarts. */
export function codexIdleWakeAt(trap: TrapRegistration): number | undefined {
  if (!trap.claimed) return undefined;
  const claim = readSessionClaim(trap.claimed, laneOf(trap.claimed) ?? 'work');
  try {
    const wake = JSON.parse(fs.readFileSync(fileFor(trap), 'utf8')) as IdleWake;
    return wake.sessionId === trap.sessionId && wake.dispatchId === trap.claimed && wake.claimAt === claim?.at && Number.isFinite(wake.at) ? wake.at : undefined;
  } catch { return undefined; }
}

export function recordCodexIdleWake(trap: TrapRegistration, now: number): void {
  if (!trap.claimed) return;
  const claim = readSessionClaim(trap.claimed, laneOf(trap.claimed) ?? 'work');
  if (!claim) return;
  const file = fileFor(trap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify({ sessionId: trap.sessionId, dispatchId: trap.claimed, claimAt: claim.at, at: now } satisfies IdleWake));
  atomicRenameSync(tmp, file);
}
