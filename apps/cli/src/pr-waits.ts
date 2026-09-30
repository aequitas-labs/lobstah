import {
  activeIds,
  appendStatus,
  chainPr,
  ghPrView,
  laneOf,
  listWatches,
  mergeEvidence,
  parsePrRef,
  readEvidence,
  readPr,
  readStatusLog,
} from '@lobstah/core';
import type { GhPrView, Lane, PrRef, StatusEntry, Watch } from '@lobstah/core';
import { autoRegisterPrWatch, observePr } from './pr-watch.js';

/** The waits a PR resolves: `paused --waiting-on pr` and `paused --waiting-on review`. */
const PR_WAITS = new Set(['pr', 'review']);

/**
 * The PR a paused dispatch waits on: its `--link` when that names a GitHub
 * PR, else its own PR (evidence), else its chain's PR, else the PR of a
 * `pr:` watch the dispatch owns.
 */
export function waitedPr(id: string, lane: Lane, entry: StatusEntry): PrRef | undefined {
  const link = entry.link ? parsePrRef(entry.link) : undefined;
  return link ?? ownPr(id, lane);
}

/** The dispatch's own PR: its evidence, else its chain's, else its `pr:` watch. */
function ownPr(id: string, lane: Lane): PrRef | undefined {
  const evidence = readEvidence(id, lane);
  const url = evidence.prUrl ?? evidence.pr?.url ?? chainPr(id, lane)?.url;
  if (url) return parsePrRef(url);
  const watch = listWatches().find((w) => w.key.startsWith('pr:') && w.owner === `dispatch:${id}`);
  return watch ? parsePrRef(watch.key) : undefined;
}

/**
 * The warning `report paused --waiting-on pr|review` prints when lobstah
 * knows no PR for the wait: nothing will finish the dispatch when a PR
 * merges or closes. Undefined for any other report.
 */
export function waitWarning(id: string, lane: Lane, entry: StatusEntry): string | undefined {
  if (entry.verb !== 'paused' || !entry.waitingOn || !PR_WAITS.has(entry.waitingOn)) return undefined;
  if (waitedPr(id, lane, entry)) return undefined;
  return (
    `no PR known for this wait: --link names no GitHub PR and the dispatch has no PR. ` +
    `A merge or close will not finish it. Report again with --link <PR url>, or report --pr <url> first.`
  );
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

/**
 * Observe each PR a parked dispatch waits on that no daemon pass observes:
 * a PR with no watch, a helm-owned watch, or a watch whose owning dispatch
 * is gone. The daemon's own pass observes a live dispatch-owned watch. A PR
 * observed less than `everySecs` ago, or already merged or closed, is not
 * read again. Returns the PR keys it read. Never throws.
 */
export function observeWaitedPrs(
  opts: { everySecs?: number; now?: number; view?: (ref: PrRef) => GhPrView } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const everyMs = (opts.everySecs ?? 45) * 1000;
  const view = opts.view ?? ghPrView;
  const observed: string[] = [];
  let daemonWatched: Set<string>;
  try {
    daemonWatched = new Set(
      listWatches()
        .filter((w) => w.key.startsWith('pr:') && w.owner.startsWith('dispatch:') && !w.done && laneOf(w.owner.slice('dispatch:'.length)))
        .map((w) => w.key),
    );
  } catch {
    return observed;
  }
  const done = new Set<string>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    let ids: string[];
    try {
      ids = activeIds(lane);
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        const last = readStatusLog(id, lane).at(-1);
        if (last?.verb !== 'paused' || !last.waitingOn || !PR_WAITS.has(last.waitingOn)) continue;
        const ref = waitedPr(id, lane, last);
        if (!ref || done.has(ref.key) || daemonWatched.has(ref.key)) continue;
        done.add(ref.key);
        const record = readPr(ref.key);
        if (record && (record.state === 'MERGED' || record.state === 'CLOSED')) continue;
        if (record && now - Date.parse(record.observedAt) < everyMs) continue;
        // Stamp the dispatch only when the PR is its own, not another PR it links.
        const own = ownPr(id, lane)?.key === ref.key;
        observePr(ref, view(ref), { ...(own ? { dispatchId: id } : {}), now: new Date(now) });
        observed.push(ref.key);
      } catch {
        // gh missing, unauthenticated, or forbidden: the next pass tries again.
      }
    }
  }
  return observed;
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
