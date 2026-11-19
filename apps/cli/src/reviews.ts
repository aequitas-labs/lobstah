import { latestRound, listReviews, loadConfig, prReviewUrl, reviewSettings, reviewStands, readRoundDraft, reviewAsker, isReviewBot, derivePrStacks } from '@lobstah/core';
import type { GlassReview, PrEvidence } from '@lobstah/core';

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

/** The glass's review rows: every item's newest round, and where the PR opens in its review tool. */
export function glassReviews(tools: Readonly<Record<string, string>> = {}): GlassReview[] {
  const out: GlassReview[] = [];
  const config = loadConfig().reviews;
  const items = listReviews();
  const evidence: PrEvidence[] = items.map(({ pr }) => ({
    ...pr, state: pr.state ?? 'OPEN', draft: pr.draft ?? false,
    reviewDecision: '', mergeStateStatus: '', observedAt: '',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  }));
  const stacks = derivePrStacks(evidence);
  // Retained branch observations keep a completed chain navigable after merge.
  // Prefer live topology; only use the historical chain when it does not overlap it.
  const historical = derivePrStacks(evidence.map(pr => ({ ...pr, state: 'OPEN' })));
  for (const stack of historical) {
    if (!stack.members.some(member => stacks.some(live => live.members.some(pr => pr.url === member.url)))) stacks.push(stack);
  }
  for (const item of items) {
    const r = latestRound(item);
    if (!r) continue;
    const stack = stacks.find(stack => stack.members.some(member => member.url === item.pr.url));
    const automatic = r.requestedAutomatically || isReviewBot(r.requestedBy);
    const person = reviewAsker(item, r);
    const asker = person.login;
    const name = person.name;
    const avatar = person.avatarUrl;
    const draft = ['drafted', 'stale'].includes(r.state) ? readRoundDraft(item.key, r.id) : undefined;
    // Submitting a review ends its request too; that round and a re-review are not removed requests.
    const requestRemoved = !!item.unseenAt && item.pr.state === 'OPEN' && r.state !== 'posted' && !r.reReview;
    out.push({
      ...(stack ? { stack: { id: stack.id, title: stack.title, keys: stack.members.map(member => items.find(item => item.pr.url === member.url)!.key) } } : {}),
      updatedAt: item.updatedAt,
      ...(r.refresh ? { updating: true } : {}),
      reReview: r.reReview, autoReapproved: r.autoReapprovals?.at(-1)?.headSha === item.pr.headSha,
      roundId: r.id, decisions: r.decisions, decisionAnswers: r.decisionAnswers,
      verdict: r.verdict, blocking: r.blocking, needsYou: r.needsYou, seenAt: r.seenAt, acknowledgedAt: r.acknowledgedAt, notification: r.notification,
      ...(draft && !('error' in draft) ? { summary: draft.body, comments: draft.comments, decisions: draft.decisions } : {}),
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
      ...(item.pr.state ? { prState: item.pr.state } : {}),
      ...(item.pr.draft !== undefined ? { prDraft: item.pr.draft } : {}),
      ...(name ? { askerName: name } : {}),
      ...(avatar ? { askerAvatarUrl: avatar } : {}),
      ...(automatic ? { automatic: true } : {}),
      ...(r.staged ? { stagedReviewUrl: `${item.pr.url}#pullrequestreview-${r.staged.reviewId}` } : {}),
      ...(item.pr.repoKey ? { repoKey: item.pr.repoKey } : {}),
      requestedBy: asker,
      requestedAt: r.requestedAt,
      state: r.state,
      ...(requestRemoved ? { requestRemoved } : {}),
      stands: !requestRemoved && reviewStands(r),
      ...(!r.refresh && r.reason ? { reason: r.reason } : {}),
      headSha: r.headSha,
      prHeadSha: item.pr.headSha,
      ...(r.draftedAt ? { draftedAt: r.draftedAt } : {}),
      ...(r.postedAt ? { postedAt: r.postedAt } : {}),
      ...(r.postedReviewId ? { postedReviewUrl: `${item.pr.url}#pullrequestreview-${r.postedReviewId}` } : {}),
      ...(r.by ? { by: r.by } : {}),
      ...(item.mutedAt ? { mutedAt: item.mutedAt } : {}),
      ...(r.staged ? { staged: true } : {}),
      ...(r.dispatch ? { dispatch: r.dispatch } : {}),
    });
  }
  return out;
}
