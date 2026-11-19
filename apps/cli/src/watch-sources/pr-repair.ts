import { randomUUID } from 'node:crypto';
import { loadConfig, readPr, readWatch, storedDescriptor } from '@lobstah/core';
import type { PrWatchServices } from '@lobstah/watch-types/pr';
import { reconcilePrRepairs } from '../pr-repair.js';
import type { RepairOptions } from '../pr-repair.js';

/** Configuration authorizes repair planning; the existing planner still enforces every gate. */
export function prRepairWatchServices(
  log: (message: string) => void,
  options: RepairOptions = {},
): Pick<PrWatchServices, 'automation' | 'effectHandler'> {
  return {
    automation: {
      propose({ snapshot, now }) {
        const record = readPr(snapshot.key);
        if (
          !loadConfig().watch.autoRepair ||
          snapshot.owner.kind !== 'dispatch' ||
          snapshot.status !== 'watching' ||
          readWatch(snapshot.key)?.done ||
          !record ||
          record.state !== 'OPEN'
        )
          return [];
        return [
          {
            actionId: 'repair',
            expectedRevision: record.headSha,
            idempotencyKey: randomUUID(),
            authority: 'config:watchTypes.pr.autoRepair',
            arguments: { now: Date.parse(now) },
          },
        ];
      },
    },
    effectHandler: {
      execution: 'sync',
      execute(request) {
        if (
          request.actionId !== 'repair' ||
          request.authorization.id !== 'config:watchTypes.pr.autoRepair' ||
          !loadConfig().watch.autoRepair
        )
          throw new Error('PR repair authority is unavailable');
        // A resumed receipt reuses the original scheduler ID, including after enqueue succeeded before acknowledgment.
        if (storedDescriptor(request.id, 'chore')) return { workIds: [request.id] };
        const record = readPr(request.reference.key);
        if (!record || record.state !== 'OPEN' || record.headSha !== request.expectedRevision)
          throw new Error('PR repair observation changed; refresh before repairing');
        const started = reconcilePrRepairs(log, 1, {
          ...options,
          now: options.now ?? Date.now(),
          keys: [record.key],
          dispatchId: request.id,
          expectedHead: request.expectedRevision,
        });
        return { workIds: started ? [request.id] : [] };
      },
    },
  };
}
