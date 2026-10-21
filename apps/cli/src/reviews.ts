import { latestRound, listReviews, prReviewUrl, reviewStands } from '@lobstah/core';
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

/** The glass's review rows: every item's newest round, and where the PR opens in its review tool. */
export function glassReviews(tools: Readonly<Record<string, string>> = {}): GlassReview[] {
  const out: GlassReview[] = [];
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r) continue;
    const automatic = r.requestedAutomatically || /(?:\[bot\]$|^github-actions$)/i.test(r.requestedBy ?? '');
    const asker = automatic ? item.pr.author : (r.requestedBy ?? item.pr.author);
    const name = automatic ? item.pr.authorName : (r.requestedByName ?? (asker === item.pr.author ? item.pr.authorName : undefined));
    const avatar = automatic ? item.pr.authorAvatarUrl : (r.requestedByAvatarUrl ?? (asker === item.pr.author ? item.pr.authorAvatarUrl : undefined));
    out.push({
      key: item.key,
      url: item.pr.url,
      reviewUrl: prReviewUrl(item.pr.url, tools),
      repo: `${item.pr.owner}/${item.pr.repo}`,
      number: item.pr.number,
      title: item.pr.title,
      author: item.pr.author,
      asker,
      ...(name ? { askerName: name } : {}),
      ...(avatar ? { askerAvatarUrl: avatar } : {}),
      ...(automatic ? { automatic: true } : {}),
      ...(r.staged ? { stagedReviewUrl: `${item.pr.url}#pullrequestreview-${r.staged.reviewId}` } : {}),
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
      ...(r.staged ? { staged: true } : {}),
    });
  }
  return out;
}
