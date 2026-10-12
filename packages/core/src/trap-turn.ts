import fs from 'node:fs';
import path from 'node:path';
import { atomicRenameSync, uniqueTempPath, lobstahHome } from './paths.js';
import { hasOpenCatch, readSessionClaim, type TrapRegistration } from './soak.js';
import { laneOf } from './worktrees.js';
import { readStatusLog } from './status.js';
import { readSessionWatcher } from './session-watcher.js';

interface TrapTurn { sessionId: string; dispatchId: string; report: string; idleSince?: string }
const fileFor = (trapId: string) => path.join(lobstahHome(), 'trap-turns', `${encodeURIComponent(trapId)}.json`);
function read(reg: TrapRegistration): TrapTurn | undefined {
  try { return JSON.parse(fs.readFileSync(fileFor(reg.trapId), 'utf8')); } catch { return undefined; }
}
function write(reg: TrapRegistration, state: TrapTurn): void {
  const file = fileFor(reg.trapId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(state));
  atomicRenameSync(tmp, file);
}
function working(reg: TrapRegistration): { dispatchId: string; report: string; note: string } | undefined {
  if (!hasOpenCatch(reg)) return undefined;
  const dispatchId = reg.claimed!;
  const lane = laneOf(dispatchId) ?? 'work';
  const claim = readSessionClaim(dispatchId, lane);
  if (claim?.by !== `wt:${reg.trapId}`) return undefined;
  const log = readStatusLog(dispatchId, lane);
  const last = log.at(-1);
  // The initial "claimed by" receipt is not a worker's progress report.
  if (last?.verb !== 'working' || !last.reported) return undefined;
  return { dispatchId, report: `${log.length}:${last.at}`, note: last.note ?? '(none)' };
}
const same = (state: TrapTurn | undefined, reg: TrapRegistration, w: { dispatchId: string; report: string }) =>
  state?.sessionId === reg.sessionId && state.dispatchId === w.dispatchId && state.report === w.report;

export function trapHasBackgroundWait(reg: TrapRegistration, now = Date.now()): boolean {
  const watcher = readSessionWatcher(reg.sessionId, now);
  return watcher?.kind === 'trap' && watcher.trapId === reg.trapId;
}

/** One correction per progress report, not an infinite Stop/park renewal loop. */
export function trapWorkingStop(reg: TrapRegistration, stopHookActive = false, now = Date.now()): { reason?: string } | undefined {
  const w = working(reg);
  if (!w) return undefined;
  const old = read(reg);
  const state: TrapTurn = { sessionId: reg.sessionId, dispatchId: w.dispatchId, report: w.report };
  if (trapHasBackgroundWait(reg, now)) {
    // A deliberately armed await, unlike the automatic Stop-hook park.
    if (old?.idleSince) write(reg, state);
    return {};
  }
  if (stopHookActive || same(old, reg, w)) {
    write(reg, { ...state, idleSince: same(old, reg, w) ? old?.idleSince ?? new Date(now).toISOString() : new Date(now).toISOString() });
    return {};
  }
  write(reg, state);
  return { reason: `You are about to go idle while dispatch ${w.dispatchId} still reports working. Report done, needs-decision (state the question and who must answer), blocked or paused first, or keep working. If you are waiting on an external await, report paused and name it. working means you are still executing and will report again. Never end a turn on working.` };
}

/** Tool activity clears idleness even when the normal activity beat is throttled. */
export function resumeTrapTurn(reg: TrapRegistration, newUserTurn = false): void {
  const state = read(reg);
  if (state?.sessionId === reg.sessionId && (state.idleSince || newUserTurn)) {
    delete state.idleSince;
    if (newUserTurn) state.report = ''; // A new turn gets its own one-shot correction.
    write(reg, state);
  }
}

export function idleWorkingTrap(reg: TrapRegistration, now = Date.now()): { since: string; note: string } | undefined {
  const w = working(reg);
  const state = read(reg);
  if (!w || !same(state, reg, w) || !state?.idleSince || !Number.isFinite(Date.parse(state.idleSince)) || trapHasBackgroundWait(reg, now)) return undefined;
  return { since: state.idleSince, note: w.note };
}
