import { createHash } from 'node:crypto';
import type {
  WatchAction,
  WatchActionGlyph,
  WatchItem,
  WatchItemAction,
  WatchItemAttention,
  WatchItemLifecycle,
  WatchItemMetadata,
  WatchItemStatus,
  WatchSourceBrand,
  WatchStatusMeaning,
} from '@lobstah/watch-types';
import type { GlassReview } from './glass.js';
import { unansweredReviewDecisions } from './review-decisions.js';
import { reviewUnreadReason, reviewUpdating } from './review-attention.js';

/**
 * The GitHub review source's item projection: one item per PR whose review
 * was requested, built from the same record the Reviews page rendered
 * before, so its order, chips, counts, unread state and controls stay the
 * same. Each control is an effect bound to an existing review handler; the
 * server resolves it again before running it.
 */

/** GitHub review requests share the GitHub brand with PRs. */
export const GITHUB_SOURCE: WatchSourceBrand = { id: 'github', name: 'GitHub', icon: { glyph: 'github' } };

/** Effects the review source declares, each bound to the review handler of the same name. */
export const REVIEW_EFFECTS = {
  draft: 'review-draft',
  redraft: 'review-redraft',
  approve: 'review-approve',
  requestChanges: 'review-request-changes',
  comment: 'review-comment',
  approveAnyway: 'review-approve-anyway',
  skip: 'review-skip',
  mute: 'review-mute',
  unmute: 'review-unmute',
  seen: 'review-seen',
  cancelMerge: 'pr-merge-cancel',
} as const;
export type ReviewEffect = (typeof REVIEW_EFFECTS)[keyof typeof REVIEW_EFFECTS];

const EFFECT_LABELS: Record<ReviewEffect, string> = {
  'review-draft': 'Draft a review',
  'review-redraft': 'Re-draft',
  'review-approve': 'Publish approval',
  'review-request-changes': 'Publish changes request',
  'review-comment': 'Publish comment',
  'review-approve-anyway': 'Approve anyway',
  'review-skip': 'Skip',
  'review-mute': 'Mute PR',
  'review-unmute': 'Unmute',
  'review-seen': 'Mark seen',
  'pr-merge-cancel': 'Cancel merge',
};

/** Every review effect is a human action that needs recorded authority; none is automatic. */
export const reviewEffectActions: WatchAction[] = Object.values(REVIEW_EFFECTS).map((id) => ({
  id,
  label: EFFECT_LABELS[id],
  requiresAuthority: true,
}));

/** What the review projection needs beyond the review record. */
export interface ReviewItemContext {
  /** The repo's review mode allows drafting (not notify-only). */
  canDraft: boolean;
  /** On-demand jobs publish by verdict when the repo allows it. */
  publish: boolean;
  /** A merge someone asked for on this PR, which its card can cancel. */
  merge?: { state: string; summary: string; baseRefName?: string; method?: 'merge' | 'squash' | 'rebase' };
}

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
const POSTED: Record<string, string> = { approve: 'approved', request_changes: 'changes requested' };
const METHOD_WORDS = { merge: 'a merge commit', squash: 'one squashed commit', rebase: 'rebased commits' } as const;
const SEND = {
  approve: { effect: REVIEW_EFFECTS.approve, posts: 'approval', glyph: 'approve' },
  request_changes: { effect: REVIEW_EFFECTS.requestChanges, posts: 'changes request', glyph: 'changes' },
  comment: { effect: REVIEW_EFFECTS.comment, posts: 'comment', glyph: 'publish' },
} as const satisfies Record<string, { effect: ReviewEffect; posts: string; glyph: WatchActionGlyph }>;
const SKIP_TITLE = "Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub.";

/** The PR's lifecycle, independent of the review round: open green, draft grey, merged purple, closed red. */
export function reviewLifecycle(review: Pick<GlassReview, 'prState' | 'prDraft' | 'state'>): WatchItemLifecycle {
  const state = review.prState ?? (review.state === 'merged' ? 'MERGED' : review.state === 'closed' ? 'CLOSED' : 'OPEN');
  if (state === 'MERGED') return { phase: 'completed', label: 'Merged' };
  if (state === 'CLOSED') return { phase: 'closed', label: 'Closed' };
  return review.prDraft ? { phase: 'draft', label: 'Draft' } : { phase: 'active', label: 'Open' };
}

/** The round's status chip: the same words and tones the Reviews page used. */
export function reviewWorkflowStatus(review: GlassReview): { label: string; meaning: WatchStatusMeaning } {
  if (reviewUpdating(review)) return { label: 'Updating', meaning: 'neutral' };
  if (review.reReview) return { label: 're-review needed', meaning: 'needs-you' };
  if (review.autoReapproved) return { label: 'automatically re-approved', meaning: 'done' };
  if (review.state === 'drafted' && unansweredReviewDecisions(review).length) return { label: 'needs your call', meaning: 'needs-you' };
  if (review.state === 'drafted') return { label: 'Ready to post', meaning: 'ready' };
  if (review.state === 'posted')
    return {
      label: (review.verdict && POSTED[review.verdict]) || 'posted',
      meaning: review.verdict === 'request_changes' ? 'caution' : 'done',
    };
  if (review.state === 'failed') return { label: 'failed', meaning: 'failed' };
  if (['dismissed', 'withdrawn', 'merged', 'closed'].includes(review.state)) return { label: review.state, meaning: 'neutral' };
  return { label: review.state, meaning: 'pending' };
}

/** The edge: red when it waits on you or failed, amber while lobstah works, green once posted, dim otherwise. */
export function reviewAttentionState(review: GlassReview): WatchItemAttention {
  if (reviewUpdating(review)) return 'none';
  if (review.reReview) return 'needs-you';
  if (review.state === 'posted') return 'ready';
  if (['dismissed', 'withdrawn', 'merged', 'closed'].includes(review.state)) return 'none';
  if (review.state === 'failed') return 'error';
  if (unansweredReviewDecisions(review).length || review.needsYou || review.stands) return 'needs-you';
  return 'working';
}

/** Actionable reviews stay counted after opening; automatic work and waiting rounds do not. */
export function reviewStanding(review: GlassReview): boolean {
  if (
    review.mutedAt ||
    reviewUpdating(review) ||
    ['MERGED', 'CLOSED'].includes(review.prState ?? '') ||
    ['merged', 'closed'].includes(review.state)
  )
    return false;
  if (review.reReview) return true;
  return review.state === 'drafted' || review.state === 'failed' || (review.state === 'requested' && !!(review.stands || review.needsYou));
}

/** A GitHub login's avatar; a bot's login names no user avatar and shows initials. */
function avatarFor(login: string): string | undefined {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? `https://avatars.githubusercontent.com/${login}?size=48` : undefined;
}

/** Fields that decide which controls are valid; a change makes a stale control conflict. Seen state is excluded. */
function controlRevision(review: GlassReview): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        review.roundId,
        review.state,
        review.headSha,
        review.prHeadSha,
        review.verdict,
        review.staged,
        review.draftedAt,
        review.decisions,
        review.decisionAnswers,
        review.mutedAt,
        review.updating,
        review.prState,
        review.prDraft,
        review.reReview,
        review.postedAt,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

const effect = (action: ReviewEffect): WatchItemAction['binding'] => ({ effect: { action } });

/** The card's controls, as the review card offered them: its main action, then Skip, Re-draft, Mute and Approve anyway in its menu. */
function reviewControls(review: GlassReview, context: ReviewItemContext): WatchItemAction[] {
  const actions: WatchItemAction[] = [];
  if (context.merge && context.merge.state === 'OPEN') {
    const how = `#${review.number} into ${context.merge.baseRefName ?? 'its base'}${context.merge.method ? ` as ${METHOD_WORDS[context.merge.method]}` : ''}`;
    actions.push({
      id: 'cancel-merge',
      label: 'Cancel merge',
      glyph: 'merge',
      placement: 'primary',
      enabled: true,
      pressed: true,
      title: `Merges ${how} once green; click to cancel`,
      progress: 'Cancelling merge…',
      done: 'Merge cancelled',
      binding: effect(REVIEW_EFFECTS.cancelMerge),
    });
  }
  const updating = reviewUpdating(review);
  const drafting = review.state === 'drafting' || updating;
  const preparing = updating ? 'Updating…' : 'Preparing draft…';
  const lifecycle = reviewLifecycle(review).phase;
  const approve: WatchItemAction | undefined =
    !drafting && (lifecycle === 'active' || lifecycle === 'draft')
      ? {
          id: 'approve-anyway',
          label: 'Approve anyway',
          glyph: 'approve',
          placement: 'menu',
          enabled: true,
          progress: 'Approving…',
          done: `Approved #${review.number}`,
          confirm: {
            title: `Approve #${review.number}?`,
            body: 'Approve this PR without the draft’s comments or findings.',
            label: 'Approve anyway',
          },
          binding: effect(REVIEW_EFFECTS.approveAnyway),
        }
      : undefined;
  if (review.mutedAt) {
    actions.push({
      id: 'unmute',
      label: 'Unmute',
      glyph: 'unmute',
      placement: 'primary',
      enabled: true,
      progress: 'Sending…',
      done: 'Unmuted',
      binding: effect(REVIEW_EFFECTS.unmute),
    });
    if (approve) actions.push(approve);
    return actions;
  }
  const postBlocked = review.state === 'drafted' && unansweredReviewDecisions(review).length > 0;
  const send = SEND[review.verdict ?? 'comment'];
  const verdictDone =
    send.effect === REVIEW_EFFECTS.approve
      ? `Approved #${review.number}`
      : send.effect === REVIEW_EFFECTS.requestChanges
        ? `Requested changes on #${review.number}`
        : `Published a comment on #${review.number}`;
  const sending =
    send.effect === REVIEW_EFFECTS.approve ? 'Approving…' : send.effect === REVIEW_EFFECTS.requestChanges ? 'Requesting changes…' : 'Publishing…';
  if (review.state === 'drafted' || drafting)
    actions.push({
      id: 'publish',
      label: drafting ? preparing : 'Publish',
      glyph: send.glyph,
      placement: 'primary',
      enabled: !drafting && !postBlocked,
      title: drafting ? preparing : `Publish ${send.posts}`,
      progress: sending,
      done: verdictDone,
      binding: effect(send.effect),
    });
  else if ((context.canDraft && ['requested', 'failed'].includes(review.state)) || review.state === 'stale') {
    const redraft = review.state === 'stale';
    actions.push({
      id: redraft ? 'redraft' : 'draft',
      label: redraft ? 'Re-draft' : context.publish ? 'Review (publish)' : 'Review (draft)',
      glyph: 'draft',
      placement: 'primary',
      enabled: true,
      title: context.publish
        ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit'
        : 'Draft this round as your pending review; respects the daily limit',
      progress: 'Sending…',
      done: redraft ? 'Draft requested' : 'Draft ready',
      binding: effect(redraft ? REVIEW_EFFECTS.redraft : REVIEW_EFFECTS.draft),
    });
  }
  if (approve) actions.push(approve);
  if (OPEN.has(review.state) || review.notification)
    actions.push({
      id: 'skip',
      label: 'Skip',
      glyph: 'skip',
      placement: 'menu',
      enabled: true,
      title: SKIP_TITLE,
      progress: 'Skipping…',
      done: 'Dismissed',
      binding: effect(REVIEW_EFFECTS.skip),
    });
  if (review.state === 'drafted' && !updating)
    actions.push({
      id: 'redraft',
      label: 'Re-draft',
      glyph: 'draft',
      placement: 'menu',
      enabled: true,
      progress: 'Sending…',
      done: 'Draft requested',
      binding: effect(REVIEW_EFFECTS.redraft),
    });
  actions.push({
    id: 'mute',
    label: 'Mute PR',
    glyph: 'mute',
    placement: 'menu',
    enabled: true,
    title: 'Stop new review requests until you unmute this PR',
    progress: 'Muting…',
    done: 'Muted',
    binding: effect(REVIEW_EFFECTS.mute),
  });
  const draft = review.staged ? (review.stagedReviewUrl ?? review.reviewUrl) : undefined;
  actions.push({
    id: 'open',
    label: draft ? 'Open draft' : 'Open',
    placement: 'open',
    enabled: true,
    acknowledges: true,
    binding: { link: { href: draft ?? review.reviewUrl } },
  });
  return actions;
}

/** One review request as an item in the shared card slots. */
export function reviewWatchItem(review: GlassReview, context: ReviewItemContext): WatchItem {
  const lifecycle = reviewLifecycle(review);
  const workflow = reviewWorkflowStatus(review);
  const statuses: WatchItemStatus[] = [];
  // The lifecycle chip already says merged or closed; a matching round word is not repeated.
  if (workflow.label.toLowerCase() !== lifecycle.label.toLowerCase())
    statuses.push({ code: 'round', label: workflow.label, category: 'workflow', meaning: workflow.meaning });
  if (review.mutedAt) statuses.push({ code: 'muted', label: 'muted', category: 'workflow', meaning: 'neutral' });
  if (review.postedAt)
    statuses.push({
      code: 'posted',
      label: 'Posted',
      category: 'workflow',
      meaning: 'done',
      at: review.postedAt,
      target: { href: review.postedReviewUrl ?? review.reviewUrl },
    });
  if (context.merge)
    statuses.push({
      code: 'merge-when-green',
      label: 'Merge when green',
      category: 'workflow',
      meaning: 'caution',
      note: context.merge.state === 'MERGED' ? 'Merged' : context.merge.summary,
    });
  const login = review.asker ?? review.requestedBy ?? review.author;
  const avatarUrl = review.askerAvatarUrl ?? avatarFor(login);
  const metadata: WatchItemMetadata[] = [
    { kind: 'project', value: review.repo },
    { kind: 'time', value: review.requestedAt },
    { kind: 'reference', value: `#${review.number}` },
    ...(review.dispatch ? [{ kind: 'owner' as const, value: `dispatch:${review.dispatch}` }] : []),
    { kind: 'person', value: review.author, label: 'author' },
  ];
  const updatedAt = review.updatedAt ?? review.postedAt;
  return {
    id: review.key,
    revision: controlRevision(review),
    title: review.title,
    kind: 'pull-request',
    glyph: { kind: 'pull-request' },
    lifecycle,
    statuses,
    attention: reviewAttentionState(review),
    notification: {
      revision: `${review.roundId ?? ''}:${review.state}:${review.reReview?.at ?? review.notification?.at ?? review.draftedAt ?? review.requestedAt}`,
      unread: reviewUnreadReason(review) !== undefined,
      seen: !!(review.seenAt || review.acknowledgedAt),
      action: REVIEW_EFFECTS.seen,
    },
    standing: reviewStanding(review),
    answered: review.state === 'posted' && !review.reReview,
    resolved: !OPEN.has(review.state),
    person: {
      id: login,
      ...(review.askerName ? { name: review.askerName } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      role: 'requested by',
      ...(review.automatic ? { badge: { label: 'automatic', detail: 'A bot re-requested this review' } } : {}),
    },
    metadata,
    notes: [
      ...(review.summary ? [{ label: 'Summary', text: review.summary }] : []),
      ...(review.blocking ?? []).map((finding) => ({ text: `${finding.path}:${finding.line} · ${finding.body}`, meaning: 'failed' as const })),
    ],
    requestedAt: review.requestedAt,
    ...(updatedAt ? { updatedAt } : {}),
    target: { open: { type: 'review', key: review.key } },
    actions: reviewControls(review, context),
    surfaces: { list: ['reviews'], home: 'reviews' },
    ...(review.stack
      ? {
          group: {
            id: review.stack.id,
            ...(review.stack.title ? { title: review.stack.title } : {}),
            ...(review.stack.keys.includes(review.key) ? { position: review.stack.keys.indexOf(review.key) } : {}),
          },
        }
      : {}),
    ...(review.repoKey ? { repo: review.repoKey } : {}),
  };
}
