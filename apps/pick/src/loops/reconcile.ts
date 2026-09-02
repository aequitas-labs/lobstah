import { cancelRequested, laneDirs, requestCancel } from '@lobstah/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane } from '@lobstah/core';
import type { Source } from '../types.js';
import type { PickupState } from '../state.js';
import { dispatchLane } from './report.js';

function dispatchActive(uuid: string): Lane | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    if (fs.existsSync(path.join(d.active, uuid)) || fs.existsSync(path.join(d.queue, `${uuid}.json`))) {
      return lane;
    }
  }
  return undefined;
}

/**
 * Both directions of tracker drift. An orphan verdict requires a trustworthy
 * mapping: a missing entry is unknown and triggers a rebuild from the tracker
 * trail first — only a rebuilt table may declare an orphan. Losing a file
 * must never cancel live work.
 */
export async function reconcileLoop(
  source: Source,
  state: PickupState,
  log: (m: string) => void = () => {},
): Promise<void> {
  for (const { key, open } of await source.inProgress()) {
    let entry = state.get(key);
    if (!entry) {
      const recovered = await source.recoverUuid(key);
      if (recovered) {
        state.set(key, { uuid: recovered, kind: 'issue', createdAt: new Date().toISOString(), recovered: true });
        entry = state.get(key);
        log(`${key}: rebuilt mapping to ${recovered} from the tracker trail`);
      }
    }
    if (!entry) {
      if (open) {
        await source.reset(key, 'no dispatch backs this item — resetting to the start state');
        log(`${key}: orphaned item, reset`);
      }
      continue;
    }
    if (!open) {
      const lane = dispatchActive(entry.uuid);
      if (lane && !cancelRequested(entry.uuid, lane)) {
        try {
          requestCancel(entry.uuid, lane);
          log(`${key}: item closed, cancelled orphaned dispatch ${entry.uuid}`);
        } catch {
          // still queued (no active dir) — the claim/spawn path will notice
        }
      }
    }
  }
}
