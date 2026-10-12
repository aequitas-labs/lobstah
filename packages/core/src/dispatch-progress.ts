import { loadConfig } from './config.js';
import type { Config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { laneDirs } from './paths.js';
import { activeIds, pendingIds, queuedAt, storedDescriptor, cancelRequested } from './queue.js';
import { readSessionClaim, trapByAddress, trapLabel, hasOpenCatch } from './soak.js';
import { readStatusLog } from './status.js';
import { readActivity, ageLabel } from './activity.js';
import { lastEventAt } from './events.js';
import { slotUsage } from './slots.js';
import { poolWaits } from './pools.js';
import { readHold, holdReason } from './disk.js';
import { postNotice } from './notices.js';
import type { Descriptor, Lane } from './types.js';

/** Observational only: never reroute sticky work or acquire a worker slot. */
export function dispatchQueueReason(d: Descriptor, lane: Lane, cfg = loadConfig(), now = Date.now()): string {
  if (d.for) {
    const trap = trapByAddress(d.for);
    if (!trap) return `addressed to trap ${d.for}, which is not signed on`;
    if (hasOpenCatch(trap)) return `addressed to ${trapLabel(trap)}, busy on dispatch ${trap.claimed}`;
    if (now - Date.parse(trap.heartbeatAt) > cfg.soak.ttlSecs * 1000) return `addressed to ${trapLabel(trap)}, which is no longer answering`;
    return `addressed to ${trapLabel(trap)}, waiting for its session to take the brief`;
  }
  if (!cfg.repos[d.repo]) return `repo ${d.repo} is not configured`;
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
  repo: string;
  state: 'queued-too-long' | 'stalled';
  since: string;
  ageSecs: number;
  stateHash: string;
  text: string;
  thresholdSecs: number;
}

/** Current conditions, independent of notice consumption or daemon restarts. */
export function dispatchProgress(now = Date.now(), cfg: Config = loadConfig()): DispatchProgress[] {
  const out: DispatchProgress[] = [];
  for (const lane of ['work', 'chore'] as const) {
    for (const id of pendingIds(lane)) {
      const d = storedDescriptor(id, lane);
      const since = queuedAt(id, lane);
      if (!d || !since) continue;
      const ageSecs = (now - Date.parse(since)) / 1000;
      if (cfg.helm.queuedNoticeSecs <= 0 || ageSecs < cfg.helm.queuedNoticeSecs) continue;
      out.push({ id, lane, repo: d.repo, state: 'queued-too-long', since, ageSecs,
        thresholdSecs: cfg.helm.queuedNoticeSecs, stateHash: `queued:${since}`,
        text: `queued-too-long ${id} (${ageLabel(ageSecs * 1000)}): ${dispatchQueueReason(d, lane, cfg, now)}. Cancel and re-dispatch unaddressed, or cancel and re-address to another trap.` });
    }
    for (const id of activeIds(lane)) {
      if (cancelRequested(id, lane)) continue;
      const last = readStatusLog(id, lane).at(-1);
      if (last && ['done', 'failed', 'paused', 'needs-decision', 'blocked'].includes(last.verb)) continue;
      const d = storedDescriptor(id, lane);
      const claim = readSessionClaim(id, lane);
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
        text: `stalled ${id}: no activity or note for ${ageLabel(ageSecs * 1000)} (last activity/note ${since}); last note: ${last?.note ?? '(none)'}. Check the worker with lobstah status ${id}; resolve or cancel and re-dispatch.` });
    }
  }
  return out;
}

/** First wake at the threshold; reminders at +15m, +45m, +105m, … . */
export function noticeDispatchProgress(now = Date.now(), cfg = loadConfig()): void {
  for (const p of dispatchProgress(now, cfg)) {
    const reminder = Math.floor(Math.log2(1 + Math.max(0, p.ageSecs - p.thresholdSecs) / 900));
    postNotice({ kind: 'dispatch-progress', refId: p.id, repo: p.repo, text: p.text,
      stateHash: p.stateHash, dedupeKey: `dispatch-progress-${p.lane}-${p.id}-${p.stateHash}-${reminder}` });
  }
}
