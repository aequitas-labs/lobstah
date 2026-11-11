import { dispatchPrUrls, parsePrRef, readEvidence, readSessionClaim, storedDescriptor } from '@lobstah/core';
import type { Lane } from '@lobstah/core';

/** The waits a PR resolves, which a trap does not park on. */
const PR_WAITS = ['pr', 'review'];

/**
 * A trap never parks on its own PR's CI or review: its work is done once the
 * PR is up, and the PR's watch starts the next round on review feedback, a
 * failing check or a merge. So `report paused --waiting-on pr|review` from a
 * trap-claimed dispatch, about one of its own PRs, is recorded as
 * `done --pr <that PR>`, which frees the trap. A wait on another PR (one it
 * depends on), on anything else (deploy, external, heavy), and every
 * headless or configured dispatch keep their pause. Undefined when the report
 * stands as written.
 */
export function trapPrWaitAsDone(
  id: string,
  lane: Lane,
  verb: string,
  waiting: { waitingOn?: string; link?: string },
  reportedPrs: readonly string[],
): { prs: string[] } | undefined {
  if (verb !== 'paused' || !waiting.waitingOn || !PR_WAITS.includes(waiting.waitingOn)) return undefined;
  if (!readSessionClaim(id, lane)?.by.startsWith('wt:') || storedDescriptor(id, lane)?.target) return undefined;
  const own = [...reportedPrs, ...dispatchPrUrls(readEvidence(id, lane))];
  const ownKeys = new Set(own.flatMap((u) => parsePrRef(u)?.key ?? []));
  const linked = waiting.link ? parsePrRef(waiting.link) : undefined;
  if (waiting.link && !(linked && ownKeys.has(linked.key))) return undefined;
  const prs = [...new Set(reportedPrs.length ? reportedPrs : linked ? [waiting.link!] : own)];
  return prs.length ? { prs } : undefined;
}
