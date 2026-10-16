import { randomUUID } from 'node:crypto';
import {
  enqueue,
  lastEventAt,
  loadConfig,
  queuedDescriptor,
  readEvidence,
  readSessionClaim,
  readStatusLog,
  readTrap,
  reconcile,
  storedDescriptor,
  trapLastSeen,
} from '@lobstah/core';
import type { Descriptor } from '@lobstah/core';
import type { PollContext, PrRun, Source, WorkItem } from '../types.js';
import type { MapEntry, PickupState } from '../state.js';
import { dispatchLane } from './report.js';
import { pickupPool } from '../config.js';

function terminal(uuid: string): boolean {
  const lane = dispatchLane(uuid);
  if (!lane) return true; // culled — nothing to collide with
  const verb = reconcile({ log: readStatusLog(uuid, lane), lastEventAt: lastEventAt(uuid, lane) });
  return verb === 'done' || verb === 'failed';
}

/** When a dispatch worked: from `start` until it finished, or open while it runs. A culled one spans no time. */
function runOf(uuid: string, start: string, heldOnly?: boolean): PrRun {
  const lane = dispatchLane(uuid);
  const end = !lane ? start : terminal(uuid) ? (readStatusLog(uuid, lane).at(-1)?.at ?? start) : undefined;
  return { start, ...(end !== undefined ? { end } : {}), ...(heldOnly ? { heldOnly } : {}) };
}

/** The runs on a review subject, for the active-round guard. */
function pollContext(state: PickupState): PollContext {
  return {
    runs(subject, followUp) {
      const runs: PrRun[] = [];
      const lane = dispatchLane(followUp);
      // Descriptors from before `queuedAt` start at their first status entry.
      const start = lane ? (storedDescriptor(followUp, lane)?.queuedAt ?? readStatusLog(followUp, lane)[0]?.at) : undefined;
      if (start) runs.push(runOf(followUp, start));
      for (const [key, e] of state.entries()) if (key.startsWith(`${subject}@`)) runs.push(runOf(e.uuid, e.createdAt, e.heldOnly));
      return runs;
    },
  };
}

/** The trap (`wt:<id>`) that worked a dispatch, when it is still live: its claim, else its delivery receipt. */
function liveTrapOf(uuid: string | undefined, ttlSecs: number, now: number): string | undefined {
  const lane = uuid ? dispatchLane(uuid) : undefined;
  if (!uuid || !lane) return undefined;
  const claimed = readSessionClaim(uuid, lane)?.by;
  const delivered = readEvidence(uuid, lane).deliveredTo;
  const address = claimed?.startsWith('wt:') ? claimed : delivered?.startsWith('wt:') ? delivered : undefined;
  const trap = address ? readTrap(address.slice('wt:'.length)) : undefined;
  return trap && now - trapLastSeen(trap) <= ttlSecs * 1000 ? address : undefined;
}

/**
 * A round addressed to its PR's trap waits `[watch].repairTrapWaitSecs` for
 * it, like a repair chore. Past that, it goes back to the general queue: any
 * trap of the repo, or the daemon.
 */
function releaseExpiredRounds(state: PickupState, now: number, log: (m: string) => void): void {
  for (const [key, e] of state.entries()) {
    if (e.kind !== 'review') continue;
    const queued: Descriptor | undefined = queuedDescriptor(e.uuid, 'work');
    const until = queued?.systemRepair?.trapWaitUntil;
    if (!queued?.for || !until || now < Date.parse(until)) continue;
    enqueue({ ...queued, for: undefined, systemRepair: {} }, 'work');
    log(`${key}: ${queued.for} did not take the round in time; any worker may now`);
  }
}

/**
 * Where a review round forks from, and whether it may start yet. Rounds on
 * one subject share a worktree lineage, so exactly one runs at a time —
 * feedback arriving mid-round buffers behind its key and re-enters next
 * poll. The fork target is the newest prior round still on disk (the latest
 * session in the chain), falling back to the implementation dispatch; a
 * fully culled chain starts cold and reads the thread like anyone else.
 */
function roundPlan(item: WorkItem, state: PickupState): { hold: boolean; followUp?: string } {
  const rounds: MapEntry[] = item.subject
    ? state
        .entries()
        .filter(([k]) => k.startsWith(`${item.subject}@`))
        .map(([, e]) => e)
    : [];
  const chain = [...rounds.map((e) => e.uuid), ...(item.followUp ? [item.followUp] : [])];
  if (chain.some((uuid) => !terminal(uuid))) return { hold: true };
  const forkable = rounds
    .filter((e) => dispatchLane(e.uuid))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1)?.uuid;
  const target = forkable ?? item.followUp;
  return { hold: false, followUp: target && dispatchLane(target) ? target : undefined };
}

/**
 * Issue and review pickup. No LLM anywhere: translation is mechanical, and
 * judgment about an ambiguous item belongs to the dispatched agent, which
 * reports needs-decision.
 */
export async function dispatchLoop(
  source: Source,
  state: PickupState,
  log: (m: string) => void = () => {},
  /** `[pickup].pools`: an issue dispatch runs in the first one serving its repo. */
  pools: string[] = [],
): Promise<void> {
  const cfg = loadConfig();
  const now = Date.now();
  releaseExpiredRounds(state, now, log);
  const items: WorkItem[] = await source.poll(pollContext(state));
  const maxAttempts = 1 + cfg.limits.maxRestartAttempts;
  for (const item of items) {
    const previous = state.get(item.key);
    if (previous) {
      if (item.kind !== 'issue' || previous.kind !== 'issue' || !previous.released) continue;
      if ((previous.attempts ?? 1) >= maxAttempts) {
        log(`${item.key}: issue attempt limit (${maxAttempts}) reached — holding for a human`);
        continue;
      }
    }
    const plan = item.kind === 'review' ? roundPlan(item, state) : { hold: false, followUp: undefined };
    if (plan.hold) {
      log(`${item.key}: a prior round is still in flight — holding`);
      continue;
    }
    if (!(await source.claim(item))) {
      log(`${item.key}: claim lost — another machine has it`);
      continue;
    }
    const id = randomUUID();
    const pool = pickupPool(pools, item.repoKey);
    // A review round goes to the trap that owns the PR while it is live.
    const waitSecs = Math.max(0, Number.isFinite(cfg.watch.repairTrapWaitSecs) ? cfg.watch.repairTrapWaitSecs : 600);
    const trap = item.kind === 'review' && waitSecs > 0 ? liveTrapOf(plan.followUp ?? item.followUp, cfg.soak.ttlSecs, now) : undefined;
    enqueue(
      {
        id,
        repo: item.repoKey,
        brief: item.brief,
        // A review dispatch forks the latest session in its chain; issues start cold.
        ...(plan.followUp ? { followUp: plan.followUp } : {}),
        // An issue starts fresh in a warm pool worktree when a pool serves its repo.
        ...(item.kind === 'issue' && pool ? { pool } : {}),
        ...(trap ? { for: trap, systemRepair: { trapWaitUntil: new Date(now + waitSecs * 1000).toISOString() } } : {}),
      },
      'work',
    );
    state.set(item.key, {
      uuid: id,
      kind: item.kind,
      createdAt: new Date().toISOString(),
      ...(item.kind === 'issue' ? { attempts: previous ? (previous.attempts ?? 1) + 1 : 1 } : {}),
      ...(item.heldOnly ? { heldOnly: true } : {}),
    });
    log(`${item.key}: dispatched as ${id}${trap ? ` for ${trap}` : ''}`);
  }
}
