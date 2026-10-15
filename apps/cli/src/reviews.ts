import { latestRound, listReviews, readRoundDraft, reviewStands } from '@lobstah/core';
import type { GlassReview } from '@lobstah/core';

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);

/** The rows `lobstah reviews` prints, newest change first: open rounds, or every item with `all`. */
export function reviewRows(all = false): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r || (!all && !OPEN.has(r.state))) continue;
    rows.push({
      key: item.key,
      url: item.pr.url,
      title: item.pr.title,
      author: item.pr.author,
      requestedBy: r.requestedBy ?? '',
      state: r.state,
      requestedAt: r.requestedAt,
      reason: r.reason ?? '',
    });
  }
  return rows;
}

/** The glass's review rows: every item's newest round, with the draft of a drafted or stale one. */
export function glassReviews(): GlassReview[] {
  const out: GlassReview[] = [];
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r) continue;
    const draft = r.state === 'drafted' || r.state === 'stale' ? readRoundDraft(item.key, r.id) : undefined;
    out.push({
      key: item.key,
      url: item.pr.url,
      repo: `${item.pr.owner}/${item.pr.repo}`,
      number: item.pr.number,
      title: item.pr.title,
      author: item.pr.author,
      ...(item.pr.repoKey ? { repoKey: item.pr.repoKey } : {}),
      ...(r.requestedBy ? { requestedBy: r.requestedBy } : {}),
      requestedAt: r.requestedAt,
      state: r.state,
      stands: reviewStands(r),
      ...(r.reason ? { reason: r.reason } : {}),
      headSha: r.headSha,
      prHeadSha: item.pr.headSha,
      ...(r.draftedAt ? { draftedAt: r.draftedAt } : {}),
      ...(r.postedAt ? { postedAt: r.postedAt } : {}),
      ...(r.by ? { by: r.by } : {}),
      ...(draft && !('error' in draft) ? { body: draft.body, comments: draft.comments } : {}),
    });
  }
  return out;
}
