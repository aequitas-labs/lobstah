import { randomUUID } from 'node:crypto';
import { enqueue, lastEventAt, readStatusLog, reconcile } from '@lobstah/core';
import type { Source, WorkItem } from '../types.js';
import type { MapEntry, PickupState } from '../state.js';
import { dispatchLane } from './report.js';

function terminal(uuid: string): boolean {
  const lane = dispatchLane(uuid);
  if (!lane) return true; // culled — nothing to collide with
  const verb = reconcile({ log: readStatusLog(uuid, lane), lastEventAt: lastEventAt(uuid, lane) });
  return verb === 'done' || verb === 'failed';
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
): Promise<void> {
  const items: WorkItem[] = await source.poll();
  for (const item of items) {
    if (state.get(item.key)) continue; // already dispatched — dedupe by tracker key
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
    enqueue(
      {
        id,
        repo: item.repoKey,
        brief: item.brief,
        // A review dispatch forks the latest session in its chain; issues start cold.
        ...(plan.followUp ? { followUp: plan.followUp } : {}),
      },
      'work',
    );
    state.set(item.key, { uuid: id, kind: item.kind, createdAt: new Date().toISOString() });
    log(`${item.key}: dispatched as ${id}`);
  }
}
