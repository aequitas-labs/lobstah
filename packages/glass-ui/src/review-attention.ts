import type { GlassReview } from '@lobstah/core';
import { unansweredReviewDecisions } from '@lobstah/core/dist/review-decisions.js';

/** Automatic draft maintenance does not ask the person to repair it. */
export const reviewUpdating = (r: Pick<GlassReview, 'state' | 'repairDraft' | 'reason'>): boolean =>
  r.state === 'stale' || !!r.reason?.startsWith('stage failed') || !!r.repairDraft && ['requested', 'drafting'].includes(r.state);

/** One rule for the Reviews badge and each row's unread marker; closed rounds never count. */
export function reviewUnreadReason(review: GlassReview): string | undefined {
  if (reviewUpdating(review)) return undefined;
  if (review.mutedAt || ['CLOSED', 'MERGED'].includes(review.prState ?? '') ||
      (!review.reReview && !['requested', 'drafting', 'drafted', 'stale', 'failed'].includes(review.state))) return undefined;
  const since = review.reReview?.at ?? review.notification?.at ?? review.draftedAt ?? review.requestedAt;
  if ((review.seenAt && review.seenAt >= since) || (review.acknowledgedAt && review.acknowledgedAt >= since)) return undefined;
  if (review.reReview) return 'Re-review needed';
  if (review.state === 'drafted' && unansweredReviewDecisions(review).length) return 'Needs your call';
  if (review.notification?.kind === 'published') return 'New posted review';
  if (review.notification) return 'New draft';
  if (!review.stands && !review.needsYou) return undefined;
  if (review.state === 'requested') return 'Ready to draft';
  if (review.state === 'failed') return 'Draft failed';
  if (review.state === 'drafted') return 'Draft ready';
  return undefined;
}
