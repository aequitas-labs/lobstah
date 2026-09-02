import { randomUUID } from 'node:crypto';
import { enqueue } from '@lobstah/core';
import type { Source, WorkItem } from '../types.js';
import type { PickupState } from '../state.js';

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
        // A review dispatch forks the implementation session; issues start cold.
        ...(item.kind === 'review' && item.followUp ? { followUp: item.followUp } : {}),
      },
      'work',
    );
    state.set(item.key, { uuid: id, kind: item.kind, createdAt: new Date().toISOString() });
    log(`${item.key}: dispatched as ${id}`);
  }
}
