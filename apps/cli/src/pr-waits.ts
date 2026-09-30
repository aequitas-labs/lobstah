import {
  activeIds,
  appendStatus,
  chainPr,
  dispatchPrUrls,
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
 * The PRs a paused dispatch waits on. A `--link` to a GitHub PR that is not
 * one of the dispatch's own is the one PR waited on. Otherwise it waits on
 * all of its own PRs: its evidence (`prUrl` and `prUrls`), else its chain's
 * PR, else the PRs of the `pr:` watches it owns.
 */
export function waitedPrs(id: string, lane: Lane, entry: StatusEntry): PrRef[] {
  const link = entry.link ? parsePrRef(entry.link) : undefined;
  const own = ownPrs(id, lane);
  if (link && !own.some((r) => r.key === link.key)) return [link];
  return own;
}

/** The dispatch's own PRs: its evidence, else its chain's, else its `pr:` watches. */
function ownPrs(id: string, lane: Lane): PrRef[] {
  const evidence = readEvidence(id, lane);
  let urls = dispatchPrUrls(evidence);
  if (urls.length === 0) {
    const chain = chainPr(id, lane)?.url;
    urls = chain ? [chain] : listWatches().filter((w) => w.key.startsWith('pr:') && w.owner === `dispatch:${id}`).map((w) => w.key);
  }
  return urls.map((u) => parsePrRef(u)).filter((r): r is PrRef => !!r);
}

/**
 * The warning `report paused --waiting-on pr|review` prints when lobstah
 * knows no PR for the wait: nothing will finish the dispatch when a PR
 * merges or closes. Undefined for any other report.
 */
export function waitWarning(id: string, lane: Lane, entry: StatusEntry): string | undefined {
  if (entry.verb !== 'paused' || !entry.waitingOn || !PR_WAITS.has(entry.waitingOn)) return undefined;
  if (waitedPrs(id, lane, entry).length > 0) return undefined;
  return (
    `no PR known for this wait: --link names no GitHub PR and the dispatch has no PR. ` +
    `A merge or close will not finish it. Report again with --link <PR url>, or report --pr <url> first.`
  );
}

/**
 * `report paused --waiting-on pr|review` on the dispatch's own PRs registers
 * each PR's watch when it has none, as `done --pr` does, so their merges are
 * observed. A `--link` to another PR registers nothing. Never throws.
 */
export function registerWaitWatches(id: string, lane: Lane, entry: StatusEntry): Watch[] {
  try {
    if (entry.verb !== 'paused' || !entry.waitingOn || !PR_WAITS.has(entry.waitingOn)) return [];
    const own = ownPrs(id, lane);
    const link = entry.link ? parsePrRef(entry.link) : undefined;
    if (own.length === 0 || (link && !own.some((r) => r.key === link.key))) return [];
    return own.map((r) => autoRegisterPrWatch(id, r.url)).filter((w): w is Watch => !!w);
  } catch {
    return [];
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
        const own = new Set(ownPrs(id, lane).map((r) => r.key));
        for (const ref of waitedPrs(id, lane, last)) {
          if (done.has(ref.key) || daemonWatched.has(ref.key)) continue;
          done.add(ref.key);
          const record = readPr(ref.key);
          if (record && (record.state === 'MERGED' || record.state === 'CLOSED')) continue;
          if (record && now - Date.parse(record.observedAt) < everyMs) continue;
          try {
            // Stamp the dispatch only when the PR is its own, not another PR it links.
            observePr(ref, view(ref), { ...(own.has(ref.key) ? { dispatchId: id } : {}), now: new Date(now) });
            observed.push(ref.key);
          } catch {
            // gh missing, unauthenticated, or forbidden: the next pass tries again.
          }
        }
      } catch {
        // An unreadable dispatch is skipped.
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
 * Finish every dispatch parked on PRs that have all ended. A dispatch whose
 * last report is `paused --waiting-on pr|review` finishes when every PR it
 * waits on is MERGED or CLOSED: `done` when one merged (the work landed),
 * `failed` when all closed without merge. Every such dispatch is finished,
 * in every chain, not only the newest. The daemon runs this after it observes PR watches and before its
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
      const refs = waitedPrs(id, lane, last);
      const states = refs.map((r) => readPr(r.key)?.state);
      if (refs.length === 0 || !states.every((st) => st === 'MERGED' || st === 'CLOSED')) continue;
      const merged = refs.filter((_, i) => states[i] === 'MERGED');
      const closed = refs.filter((_, i) => states[i] === 'CLOSED');
      const verb = merged.length > 0 ? 'done' : 'failed';
      const urls = (rs: PrRef[]) => rs.map((r) => r.url).join(', ');
      const note =
        refs.length === 1
          ? merged.length
            ? `the PR merged: ${refs[0]!.url}`
            : `the PR closed without merge: ${refs[0]!.url}`
          : closed.length === 0
            ? `the PRs merged: ${urls(merged)}`
            : merged.length === 0
              ? `the PRs closed without merge: ${urls(closed)}`
              : `the PRs ended — merged: ${urls(merged)}; closed without merge: ${urls(closed)}`;
      appendStatus(id, lane, verb, note);
      if (!readEvidence(id, lane).prUrl) mergeEvidence(id, lane, { prUrl: refs[0]!.url });
      const keys = refs.map((r) => r.key).join(', ');
      out.push({ id, lane, pr: keys, verb });
      log(`${id}: waited on ${keys}, which ${verb === 'done' ? 'merged' : 'closed without merge'} — ${verb}`);
    }
  }
  return out;
}
