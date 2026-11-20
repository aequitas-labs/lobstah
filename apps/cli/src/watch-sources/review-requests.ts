import {
  acknowledgeReview,
  glassReviewRecords,
  latestRound,
  loadConfig,
  markReviewSeen,
  prMergeStatus,
  muteReview,
  readPr,
  readReview,
  registerWatchEvent,
  reviewWatchInput,
  reviewWatchItem,
  unmuteReview,
  WatchItemConflict,
  WatchJournal,
  REVIEW_EFFECTS,
} from '@lobstah/core';
import type { GlassReview, ReviewWatchSourceOptions } from '@lobstah/core';
import type { WatchActionRequest, WatchEffectResult, WatchRegistry } from '@lobstah/watch-types';
import type { ReviewWatchReference } from '@lobstah/watch-types/review';
import { legacyPrKey } from '@lobstah/watch-types/legacy-presentation';
import { dismissReviewRound, draftReviewOnDemand, postReview, redraftReviewRound } from '@lobstah/pick';
import { reviewTools } from '../review-tools.js';

/**
 * The GitHub review source's host services. Its items, effects and legacy
 * wire records come from the same review records the Reviews page used;
 * the glass reads them only through this source.
 */

/** The legacy review records older glasses and the review detail view read. */
export function legacyReviewRecords(): GlassReview[] {
  return glassReviewRecords(reviewTools(loadConfig()));
}

/** A merge requested on the PR under review, which the review card can cancel. */
function mergeContext(review: GlassReview) {
  const record = readPr(legacyPrKey(review.key));
  const request = record?.mergeRequest;
  if (!record || !request) return undefined;
  return {
    state: record.state,
    summary: request.hold ? `On hold · ${request.hold}` : prMergeStatus(record) || 'Waiting on CI',
    ...(record.baseRefName ? { baseRefName: record.baseRefName } : {}),
    method: request.method,
  };
}
/** Every review's newest round as an item in the shared card slots. */
export function reviewItems(): ReturnType<typeof reviewWatchItem>[] {
  const setup = loadConfig().reviews;
  return legacyReviewRecords().map((review) => {
    const effective = (review.repoKey && setup.perRepo?.[review.repoKey]) || setup;
    return reviewWatchItem(review, {
      canDraft: review.mode ? review.mode !== 'notify' : effective.mode !== 'notify',
      publish: review.publish ?? effective.publish ?? false,
      merge: mergeContext(review),
    });
  });
}

/** Refusals a person reads, in place of the review handlers' internal reasons. */
export function reviewRefusal(reason: string): string {
  const why = reason.replace(/^review:[^\s]+:\s*/, '');
  if (/draft is stale|PR head changed|re-draft it before publishing/i.test(why)) return 'This draft is being updated. Try again once it is ready.';
  if (/newest round is drafting/i.test(why)) return 'This draft is being prepared. Wait for it to finish before publishing.';
  if (/already posted|already sent/i.test(why)) return 'This review has already been published.';
  if (/there is no draft to post/i.test(why)) return 'There is no draft to publish. Request a new draft first.';
  if (/does not match the draft verdict/i.test(why)) return 'The draft verdict has changed. Refresh the page before publishing.';
  if (/requires blocking findings/i.test(why)) return 'This draft has no blocking findings. Re-draft it before requesting changes.';
  return 'This review could not be changed. Try again.';
}

/** How the host acknowledges a review notification and cancels a merge; installed by the glass composition. */
export interface ReviewHostEffects {
  acknowledgeAttention(key: string): Promise<boolean>;
  cancelMerge(prKey: string, by: string): Promise<string | undefined>;
}

/**
 * Run one recorded review effect through the existing review handlers. The
 * runner has already resolved the control from cached source state and
 * recorded its authority; this re-reads the review before acting.
 */
export async function runReviewEffect(request: WatchActionRequest<ReviewWatchReference>, host: ReviewHostEffects): Promise<WatchEffectResult> {
  const args = request.arguments as { item?: unknown };
  const key = typeof args?.item === 'string' ? args.item : '';
  if (!/^review:[^\s]+#\d+$/.test(key) || key.length > 200 || !readReview(key)) throw new Error('This review is no longer listed.');
  const by = request.authorization.by;
  const kind = request.actionId;
  const done: WatchEffectResult = { workIds: [] };
  if (kind === REVIEW_EFFECTS.seen) {
    if (!(await host.acknowledgeAttention(key))) markReviewSeen(key);
    return done;
  }
  if (kind === REVIEW_EFFECTS.cancelMerge) {
    const why = await host.cancelMerge(legacyPrKey(key), by);
    if (why) throw new Error(why);
    return done;
  }
  if (kind !== REVIEW_EFFECTS.mute && kind !== REVIEW_EFFECTS.unmute) acknowledgeReview(key);
  const current = readReview(key);
  if (kind === REVIEW_EFFECTS.skip && current && latestRound(current)?.state === 'posted') return done;
  const event =
    kind === REVIEW_EFFECTS.approve ? 'APPROVE' : kind === REVIEW_EFFECTS.requestChanges ? 'REQUEST_CHANGES' : kind === REVIEW_EFFECTS.comment ? 'COMMENT' : undefined;
  const why: string | undefined =
    kind === REVIEW_EFFECTS.approveAnyway
      ? await postReview(key, { by: 'glass', approveAnyway: true }).then((out) => (out.posted ? undefined : out.why))
      : event
        ? await postReview(key, { by: 'glass', event }).then((out) => (out.posted ? undefined : out.why))
        : kind === REVIEW_EFFECTS.mute
          ? ((out) => (typeof out === 'string' ? out : undefined))(muteReview(key))
          : kind === REVIEW_EFFECTS.unmute
            ? ((out) => (typeof out === 'string' ? out : undefined))(unmuteReview(key))
            : kind === REVIEW_EFFECTS.skip
              ? await dismissReviewRound(key, 'glass')
              : kind === REVIEW_EFFECTS.draft
                ? await draftReviewOnDemand(key)
                : kind === REVIEW_EFFECTS.redraft
                  ? await redraftReviewRound(key)
                  : 'This review action is not supported.';
  // A stale draft is being updated: the glass refreshes the item instead of reporting an error.
  if (why && /draft is stale|PR head changed|re-draft it before publishing/i.test(why)) throw new WatchItemConflict(reviewRefusal(why));
  if (why) throw new Error(reviewRefusal(why));
  return done;
}

/** Keep the configured identity's review watch registered for the home helm. */
function reviewRegistration(registry: () => WatchRegistry): NonNullable<ReviewWatchSourceOptions['registration']> {
  return {
    prepare(request) {
      const identity = request.fields['reviews.identity'];
      return typeof identity === 'string' && identity ? { input: identity, options: {} } : undefined;
    },
    sync(_now, phase) {
      if (phase !== 'before-observe') return;
      const identity = reviewWatchInput();
      if (!identity) return;
      const key = `review-requests:${encodeURIComponent(identity.trim().toLowerCase())}`;
      const stored = new WatchJournal().read(key);
      if (stored && stored.status !== 'retired') return;
      registerWatchEvent(
        { event: 'local', fields: { 'reviews.identity': identity }, owner: { kind: 'helm', grounds: 'home' }, options: {} },
        registry(),
      );
    },
  };
}

/** The review source's services for the CLI composition. */
export function reviewRequestServices(registry: () => WatchRegistry, host: ReviewHostEffects): ReviewWatchSourceOptions {
  return {
    items: () => reviewItems(),
    effectHandler: { execution: 'async', execute: (request) => runReviewEffect(request, host) },
    commands: {
      bindings: [{ name: 'glass.reviews' }],
      run: () => JSON.stringify(legacyReviewRecords()),
    },
    registration: reviewRegistration(registry),
  };
}
