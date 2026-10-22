import { latestRound, listReviews, loadConfig, prReviewUrl, reviewSettings, reviewStands, readRoundDraft, reviewAsker, isReviewBot } from '@lobstah/core';
import type { GlassReview } from '@lobstah/core';

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
    });
  }
  return rows;
}

/** The glass's review rows: every item's newest round, and where the PR opens in its review tool. */
export function glassReviews(tools: Readonly<Record<string, string>> = {}): GlassReview[] {
  const out: GlassReview[] = [];
  const config = loadConfig().reviews;
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r) continue;
    const automatic = r.requestedAutomatically || isReviewBot(r.requestedBy);
    const person = reviewAsker(item, r);
    const asker = person.login;
    const name = person.name;
    const avatar = person.avatarUrl;
    const draft = ['drafted', 'stale'].includes(r.state) ? readRoundDraft(item.key, r.id) : undefined;
    out.push({
      verdict: r.verdict, blocking: r.blocking, needsYou: r.needsYou, seenAt: r.seenAt, acknowledgedAt: r.acknowledgedAt, notification: r.notification,
      ...(draft && !('error' in draft) ? { summary: draft.body } : {}),
      mode: reviewSettings(config, item.pr.repoKey).mode,
      publish: reviewSettings(config, item.pr.repoKey).publish,
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
      requestedBy: asker,
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
