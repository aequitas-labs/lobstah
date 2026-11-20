import { latestRound, listReviews, reviewAsker } from '@lobstah/core';

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);

/** The rows `lobstah reviews` prints, newest change first: open rounds, or every item with `all`. */
export function reviewRows(all: boolean = false): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r || (!all && !OPEN.has(r.state))) continue;
    rows.push({
      key: item.key,
      url: item.pr.url,
      title: item.pr.title,
      author: item.pr.author,
      requestedBy: reviewAsker(item, r).login,
      state: r.state,
      requestedAt: r.requestedAt,
      reason: r.reason ?? '',
      ...(r.staged ? { stagedReviewUrl: `${item.pr.url}#pullrequestreview-${r.staged.reviewId}` } : {}),
    });
  }
  return rows;
}
