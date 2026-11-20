import { createHash } from 'node:crypto';
import { ReviewWatchType } from '@lobstah/watch-types/review';
import type { ReviewWatchServices, ReviewWatchSnapshot } from '@lobstah/watch-types/review';
import type { WatchItem } from '@lobstah/watch-types';
import { listReviews } from './reviews.js';
import { classifyGhError } from './gh-errors.js';
import { loadConfig } from './config.js';
import { GITHUB_SOURCE, reviewEffectActions } from './review-items.js';

/** A local source revision fences reconciliation against a changed review record. */
export function reviewWatchRevision(): string {
  return createHash('sha256').update(JSON.stringify(listReviews())).digest('hex');
}

export interface ReviewWatchSourceOptions extends Pick<ReviewWatchServices, 'effectHandler' | 'automation' | 'commands' | 'registration'> {
  /** The review items for the Reviews page, projected from local review records; installed by the host. */
  items?: (snapshot: ReviewWatchSnapshot) => WatchItem[];
}

/** The configured review identity's watch, owned by the home helm, while reviews are enabled. */
export function reviewWatchInput(): string | undefined {
  const reviews = loadConfig().reviews;
  return reviews.enabled && reviews.identity ? reviews.identity : undefined;
}

/** Every host can observe the source; credential-bearing effects are installed by pickup. */
export function createReviewWatchType(options: ReviewWatchSourceOptions = {}): ReviewWatchType {
  return new ReviewWatchType({
    ...options,
    observe() {
      return { cursor: reviewWatchRevision(), events: [] };
    },
    present(snapshot) {
      const records = listReviews();
      const items = options.items?.(snapshot) ?? [];
      return {
        version: 2,
        source: GITHUB_SOURCE,
        items,
        title: `Review requests for ${snapshot.reference.identity}`,
        summary: `${records.length} recorded review requests`,
        label: 'Review requests',
        tone: 'neutral',
        worker: { steps: ['Read the review request, its recorded head and existing round before drafting a review.'] },
        helm: {
          steps: ['Read the review records and their supplied waiting reasons before starting another review worker.'],
          read: { executable: 'lobstah', args: ['reviews'] },
        },
        rows: [
          { label: 'Identity', value: snapshot.reference.identity },
          { label: 'Requests', value: String(records.length) },
        ],
        links: [],
        actions: [
          { id: 'reconcile', label: 'Reconcile review requests', requiresAuthority: true, automatic: true },
          ...(options.items || options.effectHandler ? reviewEffectActions : []),
        ],
        attention: [],
      };
    },
    failure(error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...classifyGhError(message), message };
    },
  });
}
