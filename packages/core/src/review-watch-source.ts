import { createHash } from 'node:crypto';
import { ReviewWatchType } from '@lobstah/watch-types';
import type { ReviewWatchServices } from '@lobstah/watch-types';
import { listReviews } from './reviews.js';
import { classifyGhError } from './gh-errors.js';

/** A local source revision fences reconciliation against a changed review record. */
export function reviewWatchRevision(): string {
  return createHash('sha256').update(JSON.stringify(listReviews())).digest('hex');
}
export type ReviewWatchSourceOptions = Pick<ReviewWatchServices, 'effectHandler' | 'automation'>;

/** Every host can observe the source; credential-bearing effects are installed by pickup. */
export function createReviewWatchType(options: ReviewWatchSourceOptions = {}): ReviewWatchType {
  return new ReviewWatchType({
    ...options,
    observe() {
      return { cursor: reviewWatchRevision(), events: [] };
    },
    present(snapshot) {
      const items = listReviews();
      return {
        title: `Review requests for ${snapshot.reference.identity}`,
        summary: `${items.length} recorded review requests`,
        label: 'Review requests',
        tone: 'neutral',
        worker: { steps: ['Read the review request, its recorded head and existing round before drafting a review.'] },
        helm: {
          steps: ['Read the review records and their supplied waiting reasons before starting another review worker.'],
          read: { executable: 'lobstah', args: ['reviews'] },
        },
        rows: [
          { label: 'Identity', value: snapshot.reference.identity },
          { label: 'Requests', value: String(items.length) },
        ],
        links: [],
        actions: [{ id: 'reconcile', label: 'Reconcile review requests', requiresAuthority: true, automatic: true }],
        attention: [],
      };
    },
    failure(error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...classifyGhError(message), message };
    },
  });
}
