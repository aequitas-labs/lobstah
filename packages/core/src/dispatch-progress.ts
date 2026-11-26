import { loadConfig, DEFAULT_LIMITS } from './config.js';
import type { Config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { laneDirs } from './paths.js';
import { activeIds, pendingIds, queuedAt, storedDescriptor, cancelRequested } from './queue.js';
import { readSessionClaim, trapByAddress, trapRepoLabel, hasOpenCatch, listTraps, type TrapRegistration } from './soak.js';
import { codexIdleWakeAt } from './codex-idle-recovery.js';
import { idleWorkingTrap } from './trap-turn.js';
import { readStatusLog } from './status.js';
import { readActivity, ageLabel } from './activity.js';
import { lastEventAt } from './events.js';
import { isFinished, isParked, isTrapCatch, slotUsage } from './slots.js';
import { poolWaits } from './pools.js';
import { lastHeavyRunEnd, liveHeavyTickets } from './heavy.js';
import { readHold, holdReason } from './disk.js';
import { postNotice } from './notices.js';
import { trapCapacityReason } from './trap-availability.js';
import type { Descriptor, Lane, RunnerInfo } from './types.js';
import { dispatchUsageLimit, trapUsageLimit } from './usage-limits.js';

/** Observational only: never reroute sticky work or acquire a worker slot. */
export function dispatchQueueReason(d: Descriptor, lane: Lane, cfg = loadConfig(), now = Date.now()): string {
  const turn: string | undefined = dispatchQueueTurn(d, lane);
  if (turn) return turn;
  if (d.for) {
    const limited = dispatchUsageLimit(d.id, lane);
    if (limited) return `waiting on ${limited.account} usage limit${limited.resetAt ? ` until ${limited.resetAt}` : ''}`;
    const trap = trapByAddress(d.for);
    if (!trap) return `addressed to trap ${d.for}, which is not signed on`;
    const limit = trapUsageLimit(trap);
    if (limit) return `addressed to ${trapRepoLabel(trap)}, waiting on ${limit.account} usage limit${limit.resetAt ? ` until ${limit.resetAt}` : ''}`;
    if (hasOpenCatch(trap)) return `addressed to ${trapRepoLabel(trap)}, busy on dispatch ${trap.claimed}`;
    if (now - Date.parse(trap.heartbeatAt) > cfg.soak.ttlSecs * 1000) return `addressed to ${trapRepoLabel(trap)}, which is no longer answering`;
    return `addressed to ${trapRepoLabel(trap)}, waiting for its session to take the brief`;
  }
  if (d.target) return `addressed to trap:${d.target.profile} in grounds ${d.target.grounds}, ${queueTrap(d) ? 'waiting for its session to park' : 'which is not signed on'}`;
  if (!d.repo || !cfg.repos[d.repo]) return `repo ${d.repo} is not configured`;
  if (d.trapAny) return trapCapacityReason(cfg, d.repo, d.harness, now);
  if (poolWaits(d, cfg)) return `pool ${d.pool} has no free worktree`;
  const ceiling = lane === 'chore' ? cfg.limits.choreConcurrent : cfg.limits.maxConcurrent;
  if (slotUsage(lane).headless >= ceiling) return `no free headless slot (${ceiling} ${lane} slots)`;
  const hold = readHold();
  if (hold) return holdReason(hold);
  return 'waiting for a matching trap or the daemon to claim a headless slot';
}

export interface DispatchProgress {
  id: string;
  lane: Lane;
  repo?: string;
  state: 'queued-too-long' | 'stalled' | 'idle-while-working' | 'hung';
  since: string;
  ageSecs: number;
  stateHash: string;
  text: string;
  thresholdSecs: number;
}

/**
 * When an idle trap's quiet started, counting its heavy work as working: undefined
 * while a command of its dispatch waits or runs in the heavy line, else the later
 * of `idleSince` and the end of its latest heavy run. A trap that ends its turn
 * while its checks run in the line is waiting on them, the same as a report of
 * `paused` waiting on heavy; once they finish, the usual grace period starts over.
 */
export function idleSinceAfterHeavy(dispatchId: string, trapId: string, idleSince: string, now = Date.now()): string | undefined {
  const match = { dispatch: dispatchId, trap: trapId };
  if (liveHeavyTickets(match, now).length > 0) return undefined;
  const ended = lastHeavyRunEnd(match);
  return ended !== undefined && ended > Date.parse(idleSince) ? new Date(ended).toISOString() : idleSince;
}

/**
 * A dispatch-progress notice: a dispatch queued too long or stalled, or a
 * trap idle while reporting working. Like their attention items, the glass
 * lists them only when attentionKinds names `dispatch-progress`; the helm
 * always gets them (`man wait`, `man tend`, the Stop hook).
 */
export function progressNotice(n: { kind: string }): boolean {
  return n.kind === 'dispatch-progress' || n.kind === 'trap-idle-working';
}

/** Resolve the signed-on trap named by either form of sticky delivery. */
function queueTrap(d: Descriptor): TrapRegistration | undefined {
  const target: Descriptor['target'] = d.target;
  if (!target) return d.for ? trapByAddress(d.for) : undefined;
  return listTraps().find((trap) => trap.configured?.profile === target.profile &&
    trap.configured.grounds === target.grounds && trap.configured.surface === target.surface);
}

/** Queued items share a turn only when they can use the same worker capacity. */
function queueCapacity(d: Descriptor): string {
  if (d.for || d.target) return `trap:${queueTrap(d)?.trapId ?? d.for ?? JSON.stringify(d.target)}`;
  if (d.trapAny) return `traps:${d.repo}:${d.harness ?? 'any'}`;
  return 'headless';
}

/** A missing runner file can precede launch; only ESRCH proves its process is gone. */
function runnerIsDead(id: string, lane: Lane): boolean {
  let runner: Partial<RunnerInfo>;
  try { runner = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')) as Partial<RunnerInfo>; }
  catch { return false; }
  const pid: number | undefined = runner.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  return false;
}

/** The runner record of a headless slot holder whose process answers a signal check. */
function liveRunner(id: string, lane: Lane): RunnerInfo | undefined {
  let runner: Partial<RunnerInfo>;
  try { runner = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')) as Partial<RunnerInfo>; }
  catch { return undefined; }
  const pid: number | undefined = runner.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof runner.startedAt !== 'string') return undefined;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return undefined; }
  return runner as RunnerInfo;
}

/** Headless slot holders alive past the max age with no note, activity or event in that time. */
function hungSlotHolders(lane: Lane, now: number, cfg: Config): DispatchProgress[] {
  const maxAgeSecs: number = cfg.limits.slotMaxAgeSecs ?? DEFAULT_LIMITS.slotMaxAgeSecs ?? 0;
  if (maxAgeSecs <= 0) return [];
  return activeIds(lane).flatMap((id): DispatchProgress[] => {
    if (isFinished(id, lane) || isParked(id, lane) || isTrapCatch(id, lane) || cancelRequested(id, lane)) return [];
    const last = readStatusLog(id, lane).at(-1);
    if (last && ['done', 'failed', 'paused', 'needs-decision', 'blocked'].includes(last.verb)) return [];
    const runner: RunnerInfo | undefined = liveRunner(id, lane);
    const started: number = Date.parse(runner?.startedAt ?? '');
    if (!runner || !Number.isFinite(started)) return [];
    const progress: number = Math.max(started, Date.parse(last?.at ?? '') || 0,
      Date.parse(readActivity(id, lane)?.at ?? '') || 0, lastEventAt(id, lane) ?? 0);
    const ageSecs: number = (now - started) / 1000;
    const silentSecs: number = (now - progress) / 1000;
    if (ageSecs < maxAgeSecs || silentSecs < maxAgeSecs) return [];
    return [{ id, lane, repo: storedDescriptor(id, lane)?.repo, state: 'hung', since: runner.startedAt, ageSecs,
      thresholdSecs: maxAgeSecs, stateHash: `hung:${runner.startedAt}`,
      text: `hung ${id}: ${lane === 'chore' ? 'chore' : 'work dispatch'} has held a ${lane} slot for ${ageLabel(ageSecs * 1000)} with no note or activity for ${ageLabel(silentSecs * 1000)}. Check it with lobstah status ${id}, or cancel it with lobstah cancel ${id}.` }];
  });
}

/** Count running capacity that can release a turn for this queued dispatch. */
function queueRunningCount(d: Descriptor, lane: Lane): number {
  if (d.for || d.target) {
    const trap: TrapRegistration | undefined = queueTrap(d);
    return trap && (hasOpenCatch(trap) || trap.hostedCatch) ? 1 : 0;
  }
  if (d.trapAny) return listTraps().filter((trap) => trap.repo === d.repo &&
    (!d.harness || trap.harness === d.harness) && hasOpenCatch(trap)).length;
  return activeIds(lane).filter((id) => !isFinished(id, lane) && !isParked(id, lane) &&
    !isTrapCatch(id, lane) && !runnerIsDead(id, lane)).length;
}

/** A healthy queue waits its turn indefinitely; queue age alone is not a stall. */
function dispatchQueueTurn(d: Descriptor, lane: Lane): string | undefined {
  const running: number = queueRunningCount(d, lane);
  if (running === 0) return undefined;
  const capacity: string = queueCapacity(d);
  let ahead: number = 0;
  for (const id of pendingIds(lane)) {
    if (id === d.id) break;
    const queued: Descriptor | undefined = storedDescriptor(id, lane);
    if (queued && queueCapacity(queued) === capacity) ahead++;
  }
  const trap: TrapRegistration | undefined = queueTrap(d);
  const dispatches: string = running === 1 ? 'dispatch' : 'dispatches';
  const holder: string = trap ? `${dispatches} on ${trapRepoLabel(trap)}` : d.trapAny ? `trap ${dispatches}` :
    lane === 'chore' ? `chore${running === 1 ? '' : 's'}` : `work ${dispatches}`;
  return `queued behind ${running} running ${holder} (${ahead} ahead)`;
}

/** Current attention, after Codex recovery; the daemon can also request conditions eligible for recovery. */
export function dispatchProgress(now = Date.now(), cfg: Config = loadConfig(), opts: { includeRecoverableCodex?: boolean } = {}): DispatchProgress[] {
  const out: DispatchProgress[] = [];
  for (const lane of ['work', 'chore'] as const) {
    for (const id of pendingIds(lane)) {
      const d = storedDescriptor(id, lane);
      const since = queuedAt(id, lane);
      if (!d || !since) continue;
      const ageSecs = (now - Date.parse(since)) / 1000;
      if (cfg.helm.queuedNoticeSecs <= 0 || ageSecs < cfg.helm.queuedNoticeSecs || queueRunningCount(d, lane) > 0) continue;
      const reason: string = dispatchQueueReason(d, lane, cfg, now);
      const remedy: string = lane === 'chore' ? 'Check or cancel the chore.' : 'Cancel and re-dispatch unaddressed, or cancel and re-address to another trap.';
      out.push({ id, lane, repo: d.repo, state: 'queued-too-long', since, ageSecs,
        thresholdSecs: cfg.helm.queuedNoticeSecs, stateHash: `queued:${since}`,
        text: `queued-too-long ${id} (${ageLabel(ageSecs * 1000)}): ${reason}. ${remedy}` });
    }
    for (const id of activeIds(lane)) {
      if (dispatchUsageLimit(id, lane)) continue; // A provider quota is already explained by the fleet limit notice.
      if (cancelRequested(id, lane)) continue;
      const last = readStatusLog(id, lane).at(-1);
      if (last && ['done', 'failed', 'paused', 'needs-decision', 'blocked'].includes(last.verb)) continue;
      const d = storedDescriptor(id, lane);
      const claim = readSessionClaim(id, lane);
      const trap = claim?.by ? trapByAddress(claim.by) : undefined;
      const idle = trap ? idleWorkingTrap(trap, now) : undefined;
      if (d && idle) {
        const since = idleSinceAfterHeavy(id, trap!.trapId, idle.since, now);
        if (since === undefined) continue; // Its command waits or runs in the heavy line: the trap is working.
        const ageSecs = (now - Date.parse(since)) / 1000;
        if (cfg.helm.idleWorkingNoticeSecs > 0 && ageSecs >= cfg.helm.idleWorkingNoticeSecs) {
          if (trap!.harness === 'codex' && !opts.includeRecoverableCodex) {
            const wokeAt = codexIdleWakeAt(trap!);
            // Recover once before asking the helm; activity withdraws the idle condition.
            if (wokeAt === undefined || now - wokeAt < cfg.helm.idleWorkingNoticeSecs * 1000) continue;
          }
          out.push({ id, lane, repo: d.repo, state: 'idle-while-working', since, ageSecs,
            thresholdSecs: cfg.helm.idleWorkingNoticeSecs, stateHash: `idle-working:${since}`,
            text: `idle-while-working ${id}: ${trapRepoLabel(trap!)} ended its turn ${ageLabel(ageSecs * 1000)} ago while reporting working; last note: ${idle.note}. Read the note, resolve the question on a card, or ask the worker to keep working.` });
        }
        continue; // Explicitly idle is not a silent execution stall.
      }
      let startedAt: string | undefined;
      try { startedAt = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')).startedAt; }
      catch { /* A trap has a claim, not a runner. */ }
      const signal = Math.max(Date.parse(startedAt ?? '') || 0, Date.parse(claim?.at ?? '') || 0, Date.parse(last?.at ?? '') || 0,
        Date.parse(readActivity(id, lane)?.at ?? '') || 0, lastEventAt(id, lane) ?? 0);
      if (!d || !signal) continue; // Missing signal is unknown, not proof of a stall.
      const ageSecs = (now - signal) / 1000;
      if (cfg.helm.stalledNoticeSecs <= 0 || ageSecs < cfg.helm.stalledNoticeSecs) continue;
      const since = new Date(signal).toISOString();
      out.push({ id, lane, repo: d.repo, state: 'stalled', since, ageSecs,
        thresholdSecs: cfg.helm.stalledNoticeSecs, stateHash: `stalled:${since}`,
        text: `stalled ${id}: no activity or note for ${ageLabel(ageSecs * 1000)} (last activity/note ${since}); last note: ${last?.note ?? '(none)'}. ${lane === 'chore' ? `Check the chore with lobstah status ${id}, or cancel it.` : `Check the worker with lobstah status ${id}; resolve or cancel and re-dispatch.`}` });
    }
    out.push(...hungSlotHolders(lane, now, cfg));
  }
  return out;
}

/** First wake at the threshold; reminders at +15m, +45m, +105m, … . A hung slot holder wakes once. */
export function noticeDispatchProgress(now = Date.now(), cfg = loadConfig()): void {
  for (const p of dispatchProgress(now, cfg)) {
    if (p.state === 'hung') {
      postNotice({ kind: 'dispatch-progress', refId: p.id, repo: p.repo, text: p.text,
        stateHash: p.stateHash, dedupeKey: `dispatch-hung-${p.lane}-${p.id}` });
      continue;
    }
    const reminder = Math.floor(Math.log2(1 + Math.max(0, p.ageSecs - p.thresholdSecs) / 900));
    postNotice({ kind: p.state === 'idle-while-working' ? 'trap-idle-working' : 'dispatch-progress', refId: p.id, repo: p.repo, text: p.text,
      stateHash: p.stateHash, dedupeKey: `dispatch-progress-${p.lane}-${p.id}-${p.stateHash}-${reminder}` });
  }
}
