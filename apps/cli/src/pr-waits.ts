import {
  activeIds,
  appendStatus,
  chainPr,
  mergeEvidence,
  parsePrRef,
  readEvidence,
  readPr,
  readStatusLog,
} from '@lobstah/core';
import type { Lane, PrRef, StatusEntry, Watch } from '@lobstah/core';
import { autoRegisterPrWatch } from './pr-watch.js';

/** The waits a PR resolves: `paused --waiting-on pr` and `paused --waiting-on review`. */
const PR_WAITS = new Set(['pr', 'review']);

/**
 * The PR a paused dispatch waits on: its `--link` when that names a GitHub
 * PR, else its own PR (evidence), else its chain's PR.
 */
export function waitedPr(id: string, lane: Lane, entry: StatusEntry): PrRef | undefined {
  const link = entry.link ? parsePrRef(entry.link) : undefined;
  return link ?? ownPr(id, lane);
}

/** The dispatch's own PR: its evidence, else its chain's. */
function ownPr(id: string, lane: Lane): PrRef | undefined {
  const evidence = readEvidence(id, lane);
  const url = evidence.prUrl ?? evidence.pr?.url ?? chainPr(id, lane)?.url;
  return url ? parsePrRef(url) : undefined;
}

/**
 * `report paused --waiting-on pr|review` on the dispatch's own PR registers
 * that PR's watch when it has none, as `done --pr` does, so its merge is
 * observed. A `--link` to another PR registers nothing. Never throws.
 */
export function registerWaitWatch(id: string, lane: Lane, entry: StatusEntry): Watch | undefined {
  try {
    if (entry.verb !== 'paused' || !entry.waitingOn || !PR_WAITS.has(entry.waitingOn)) return undefined;
    const own = ownPr(id, lane);
    const link = entry.link ? parsePrRef(entry.link) : undefined;
    if (!own || (link && link.key !== own.key)) return undefined;
    return autoRegisterPrWatch(id, own.url);
  } catch {
    return undefined;
  }
}

export interface FinishedWait {
  id: string;
  lane: Lane;
  pr: string;
  verb: 'done' | 'failed';
}

/**
 * Finish every dispatch parked on a PR that has ended. A dispatch whose last
 * report is `paused --waiting-on pr|review`, and whose PR record is MERGED,
 * is finished `done`: the work landed. CLOSED without merge finishes it
 * `failed`. Every such dispatch is finished, in every chain, not only the
 * newest. The daemon runs this after it observes PR watches and before its
 * cull pass, so a merged PR's worktree release sees the chain finished.
 */
export function finishResolvedWaits(log: (message: string) => void = () => {}): FinishedWait[] {
  const out: FinishedWait[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    let ids: string[];
    try {
      ids = activeIds(lane);
    } catch {
      continue;
    }
    for (const id of ids) {
      const last = readStatusLog(id, lane).at(-1);
      if (last?.verb !== 'paused' || !last.waitingOn || !PR_WAITS.has(last.waitingOn)) continue;
      const ref = waitedPr(id, lane, last);
      const record = ref ? readPr(ref.key) : undefined;
      if (!ref || !record || (record.state !== 'MERGED' && record.state !== 'CLOSED')) continue;
      const merged = record.state === 'MERGED';
      const verb = merged ? 'done' : 'failed';
      appendStatus(id, lane, verb, merged ? `the PR merged: ${ref.url}` : `the PR closed without merge: ${ref.url}`);
      if (!readEvidence(id, lane).prUrl) mergeEvidence(id, lane, { prUrl: ref.url });
      out.push({ id, lane, pr: ref.key, verb });
      log(`${id}: waited on ${ref.key}, which ${merged ? 'merged' : 'closed without merge'} — ${verb}`);
    }
  }
  return out;
}
