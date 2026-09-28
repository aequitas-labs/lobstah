import { laneDirs, lastEventAt, readEvidence, readStatusLog, reconcile } from '@lobstah/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Evidence, Lane, Verb } from '@lobstah/core';
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

/**
 * An issue brief ends in "push the branch, and open a PR", and the worker
 * attaches that PR to its done report. A run that ends done without one did
 * not finish: a push that died in the background when the session ended, or a
 * run that decided there was nothing to change. Either way there is nothing to
 * review, so it goes to a human instead of to the done state. It self-corrects
 * if the PR is attached later. Review rounds push to an existing PR and are
 * exempt.
 */
export function unfinishedNote(kind: string, status: string, evidence: Evidence): string | undefined {
  if (kind !== 'issue' || status !== 'done' || evidence.prUrl) return undefined;
  const n = evidence.commits?.length ?? 0;
  return n > 0
    ? `Ended done with ${n} commit(s) on \`${evidence.branch ?? 'its branch'}\` but no PR — the branch may never have been pushed.`
    : 'Ended done with no commits and no PR — nothing to review.';
}

export async function reportLoop(
  source: Source,
  state: PickupState,
  log: (m: string) => void = () => {},
  notify: (n: ReportNotification) => void = () => {},
): Promise<void> {
  // One unreachable item must not starve the rest of the ledger: visit every
  // entry, then reject with what failed so the cycle still logs it.
  const failures: string[] = [];
  for (const [key, entry] of state.entries()) {
    if (!source.owns(key)) continue; // the ledger is shared; its own source reports it
    if (entry.released) continue; // retain retry history without replaying the old dispatch
    try {
      const lane = dispatchLane(entry.uuid);
      if (!lane) continue; // reconcile owns missing dispatches
      const status = reconcile({
        log: readStatusLog(entry.uuid, lane),
        lastEventAt: lastEventAt(entry.uuid, lane),
      });
      const evidence = readEvidence(entry.uuid, lane);
      const unfinished = unfinishedNote(entry.kind, status, evidence);
      const verb = unfinished ? 'needs-decision' : status;
      if (verb !== 'unknown' && verb !== entry.lastReported) {
        await source.report(key, verb as Verb, { ...evidence, ...(unfinished ? { note: unfinished } : {}), uuid: entry.uuid });
        state.update(key, { lastReported: verb as Verb });
        log(`${key}: reported ${verb}`);
        notify({
          key,
          uuid: entry.uuid,
          verb: verb as Verb,
          note: unfinished ?? readStatusLog(entry.uuid, lane).at(-1)?.note,
          prUrl: evidence.prUrl,
        });
      }
      // A terminal verb can precede process exit. Wait for the daemon to move
      // the dispatch to done before allowing another attempt at the same issue.
      if (entry.kind === 'issue' && verb === 'failed' && fs.existsSync(path.join(laneDirs(lane).done, entry.uuid))) {
        state.releaseIssue(key);
        log(`${key}: finalized failure released for a bounded retry`);
        continue;
      }
      const msgs = await source.inbound(key, entry.lastInboundAt);
      if (msgs.length > 0) {
        for (const m of msgs) sendMessage(entry.uuid, lane, m, `tracker:${source.name.startsWith('gh:') ? 'github' : source.name}`);
        state.update(key, { lastInboundAt: new Date().toISOString() });
        log(`${key}: forwarded ${msgs.length} comment(s) to inbox`);
      }
    } catch (err) {
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}
