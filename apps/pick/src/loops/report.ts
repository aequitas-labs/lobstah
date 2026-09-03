import { laneDirs, lastEventAt, readEvidence, readStatusLog, reconcile } from '@lobstah/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane, Verb } from '@lobstah/core';
import { sendMessage } from '@lobstah/core';
import type { Source } from '../types.js';
import type { PickupState } from '../state.js';

export function dispatchLane(uuid: string): Lane | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    if (
      fs.existsSync(path.join(d.active, uuid)) ||
      fs.existsSync(path.join(d.queue, `${uuid}.json`)) ||
      fs.existsSync(path.join(d.done, uuid)) ||
      fs.existsSync(path.join(d.state, `${uuid}.status`))
    ) {
      return lane;
    }
  }
  return undefined;
}

/**
 * Verb changes flow to the tracker; the state file is the durable record and
 * the tracker write is the retryable notification — lastReported advances
 * only after the report call succeeds, so a lost report replays next tick.
 * Human comments flow the other way, into the dispatch inbox.
 */
export interface ReportNotification {
  key: string;
  uuid: string;
  /** A status verb, or 'watch' for a watched external source producing events. */
  verb: Verb | 'watch';
  note?: string;
  prUrl?: string;
}

export async function reportLoop(
  source: Source,
  state: PickupState,
  log: (m: string) => void = () => {},
  notify: (n: ReportNotification) => void = () => {},
): Promise<void> {
  for (const [key, entry] of state.entries()) {
    const lane = dispatchLane(entry.uuid);
    if (!lane) continue; // reconcile owns missing dispatches
    const verb = reconcile({
      log: readStatusLog(entry.uuid, lane),
      lastEventAt: lastEventAt(entry.uuid, lane),
    });
    if (verb !== 'unknown' && verb !== entry.lastReported) {
      const evidence = readEvidence(entry.uuid, lane);
      await source.report(key, verb as Verb, { ...evidence, uuid: entry.uuid });
      state.update(key, { lastReported: verb as Verb });
      log(`${key}: reported ${verb}`);
      notify({
        key,
        uuid: entry.uuid,
        verb: verb as Verb,
        note: readStatusLog(entry.uuid, lane).at(-1)?.note,
        prUrl: evidence.prUrl,
      });
    }
    const msgs = await source.inbound(key, entry.lastInboundAt);
    if (msgs.length > 0) {
      for (const m of msgs) sendMessage(entry.uuid, lane, m);
      state.update(key, { lastInboundAt: new Date().toISOString() });
      log(`${key}: forwarded ${msgs.length} comment(s) to inbox`);
    }
  }
}
