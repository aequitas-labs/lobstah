import type { GlassReview } from '@lobstah/core';
import { unansweredReviewDecisions } from '../../core/src/review-decisions.js';

/** One rule for the Reviews badge and each row's unread marker; closed rounds never count. */
export function reviewUnreadReason(review: GlassReview): string | undefined {
  if (['dismissed', 'withdrawn', 'merged', 'closed'].includes(review.state)) return undefined;
  const since = review.notification?.at ?? review.draftedAt ?? review.requestedAt;
  if ((review.seenAt && review.seenAt >= since) || (review.acknowledgedAt && review.acknowledgedAt >= since)) return undefined;
  if (review.state === 'drafted' && unansweredReviewDecisions(review).length) return 'Needs your call';
  if (review.notification?.kind === 'published') return 'New posted review';
  if (review.notification) return 'New draft';
  if (!review.stands && !review.needsYou) return undefined;
  if (review.state === 'requested') return 'Ready to draft';
  if (review.state === 'stale') return 'Head changed; redraft needed';
  if (review.state === 'failed') return 'Draft failed';
  if (review.state === 'drafted') return 'Draft ready';
  return undefined;
}
