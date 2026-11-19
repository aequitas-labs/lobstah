import type { GlassReview } from '@lobstah/core';
import { unansweredReviewDecisions } from '@lobstah/core/dist/review-decisions.js';

/** Automatic repair is progress, so it never asks for a person's attention. */
export function reviewUpdating(review: Pick<GlassReview, 'state' | 'updating' | 'reason'>): boolean {
  if (['posted', 'dismissed', 'withdrawn', 'merged', 'closed'].includes(review.state)) return false;
  return review.updating === true || review.state === 'stale' ||
    (review.state === 'drafted' && review.reason?.startsWith('stage failed') === true);
}

/** One rule for the Reviews badge and each row's unread marker; closed rounds never count. */
export function reviewUnreadReason(review: GlassReview): string | undefined {
  if (reviewUpdating(review) || review.mutedAt || ['CLOSED', 'MERGED'].includes(review.prState ?? '') ||
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
