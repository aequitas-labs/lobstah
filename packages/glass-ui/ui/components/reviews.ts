import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { GlassReview, GlassSnapshot } from '@lobstah/core';
import type { SectionInputs } from '../../src/glass-diff.js';
import {
  dismissReview,
  hideLob,
  itemEffectInFlight,
  muteReviewPr,
  reviewRequest,
  setPrefs,
  showModal,
  unmuteReviewPr,
} from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html, type Children } from '../html.js';
import { Age, Table, ageText } from './common.js';
import { can } from '../backend.js';
import { getState, setState } from '../store.js';
import { ActionIcon, Avatar, CardLink, githubAvatarUrl, SplitButton } from './card.js';
import type { CardPerson, CardTone, MenuAction } from './card.js';
import { MergeIntent, MergeWhenGreen, PrStateIcon, PrTags, StatusChip, StackCard, dispatchTrap, prShapedCard } from './prs.js';
import type { PrIconState } from './prs.js';
import { Button } from './button.js';
import { showToast } from './toast.js';
import { Dialog } from './dialog.js';
import { unansweredReviewDecisions } from '../../../core/src/review-decisions.js';
import { reviewUnreadReason, reviewUpdating } from '../review-attention.js';
import type { WatchSurfaceItem } from '@lobstah/core';
import { ItemActions, ItemGlyph, ItemStatuses, SourceLogo, openItemTarget, targetHref, watchItemCard } from './item-card.js';

/** Review failures use the shared toast without exposing CLI keys or diagnostics. */
function showReviewError(reason: string): void {
  const why = reason.replace(/^review:[^\s]+:\s*/, '');
  if (/draft is stale|PR head changed|re-draft it before publishing/i.test(why)) {
    const key = /^(review:[^\s]+):\s/.exec(reason)?.[1];
    const snapshot = getState().snapshot;
    if (snapshot && key)
      setState({
        snapshot: {
          ...snapshot,
          reviews: (snapshot.reviews ?? []).map((review) => (review.key === key ? { ...review, updating: true } : review)),
        },
      });
    return;
  }
  const message = /newest round is drafting/i.test(why)
    ? 'This draft is being prepared. Wait for it to finish before publishing.'
    : /already posted|already sent/i.test(why)
      ? 'This review has already been published.'
      : /there is no draft to post/i.test(why)
        ? 'There is no draft to publish. Request a new draft first.'
        : /does not match the draft verdict/i.test(why)
          ? 'The draft verdict has changed. Refresh the page before publishing.'
          : /requires blocking findings/i.test(why)
            ? 'This draft has no blocking findings. Re-draft it before requesting changes.'
            : 'This review could not be changed. Try again.';
  showToast(message);
}

/**
 * The Reviews tab: one row or card per PR that asked for your review,
 * the ones waiting on him first. A row opens the PR in its review tool
 * ([repos.<key>].reviewTool), where the drafted review waits as the identity's pending
 * review, to edit and send. A card opens the review's modal, with who asked,
 * the findings, the reason and the actions; its Open draft goes to the review
 * tool. On-demand jobs follow the repo’s draft/publish setting.
 */

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
/** The state as a person reads it: a staged draft is waiting in the review tool. */
export const reviewState = (r: Pick<GlassReview, 'state' | 'decisions' | 'decisionAnswers'>): string =>
  r.state === 'drafted' && unansweredReviewDecisions(r).length ? 'needs your call' : r.state;

export { reviewUpdating } from '../review-attention.js';

/** Prefer the PR lifecycle over round status; older payloads retain merged/closed and otherwise use open. */
export function reviewPrState(r: Pick<GlassReview, 'prState' | 'prDraft' | 'state'>, draft = false): PrIconState {
  const state = r.prState ?? (r.state === 'merged' ? 'MERGED' : r.state === 'closed' ? 'CLOSED' : 'OPEN');
  return state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : (r.prDraft ?? draft) ? 'draft' : 'open';
}

export const openReview = (r: Pick<GlassReview, 'reviewUrl'> & { key?: string }) => () => {
  window.open(r.reviewUrl, '_blank', 'noopener');
};

/** The meta line: who asked, when, and why the round is where it is. */
export function reviewMeta(r: GlassReview): { nodes: unknown[]; text: string } {
  const asked =
    r.askerName || r.asker || r.requestedBy
      ? `asked by ${r.askerName ?? r.asker ?? r.requestedBy}${r.automatic ? ' (automatic)' : ''}`
      : 'review requested';
  return {
    nodes: [
      r.repo,
      '#',
      String(r.number),
      ' · ',
      asked,
      ' · ',
      Age(r.requestedAt),
      ' ago',
      r.reason && !reviewUpdating(r) ? ` · ${r.reason}` : '',
    ],
    text: [`${r.repo}#${r.number}`, asked, `${ageText(r.requestedAt)} ago`, reviewUpdating(r) ? '' : (r.reason ?? '')]
      .filter(Boolean)
      .join(' · '),
  };
}

/** The rounds a boat can still dismiss: not yet posted or dismissed. */
const DISMISSABLE = ['requested', 'drafting', 'drafted', 'stale', 'failed'];

/** Dismiss, for a source whose boats carry it out (the wharf): the boat that drafted the round deletes its pending draft. */
function Dismiss({ r }: { r: GlassReview }) {
  if (!DISMISSABLE.includes(r.state)) return null;
  const dismiss = async (e: Event) => {
    e.stopPropagation();
    return dismissReview(r.key);
  };
  return html`<${Button} onError=${showReviewError} action=${dismiss} done="Sent to the boat that drafted it">Dismiss<//>`;
}

/** Mute or unmute every review round for this PR. */
function MuteAction({ r }: { r: GlassReview }) {
  if (r.mutedAt ? !can('review-unmute') : !can('review-mute')) return null;
  const change = async (e: Event) => {
    e.stopPropagation();
    return r.mutedAt ? unmuteReviewPr(r.key) : muteReviewPr(r.key);
  };
  return html`<${Button} onError=${showReviewError} action=${change} done=${r.mutedAt ? 'Unmuted' : 'Muted'}>${r.mutedAt && ActionIcon.unmute}${r.mutedAt ? 'Unmute' : 'Mute this PR'}<//>`;
}

/** Mute belongs in the card's menu; Unmute stays on the bar. */
function muteMenuAction(r: GlassReview): MenuAction | undefined {
  if (r.mutedAt || !can('review-mute')) return undefined;
  return {
    label: 'Mute PR',
    icon: ActionIcon.mute,
    title: 'Stop new review requests until you unmute this PR',
    action: async (e) => {
      e.stopPropagation();
      return muteReviewPr(r.key);
    },
    sending: 'Muting…',
    done: 'Muted',
  };
}

/** Sending a drafted review: the request, the button, and what a card's second tap says it posts. */
const SEND = {
  approve: { kind: 'review-approve', label: 'Publish', posts: 'approval' },
  request_changes: { kind: 'review-request-changes', label: 'Publish', posts: 'changes request' },
  comment: { kind: 'review-comment', label: 'Publish', posts: 'comment' },
} as const satisfies Record<string, { kind: ReviewRequestKind; label: string; posts: string }>;

/** The icon beside each verdict's send button: approve, request changes, publish a comment. */
const SEND_ICON = { approve: ActionIcon.approve, request_changes: ActionIcon.changes, comment: ActionIcon.publish } as const;

/**
 * The review's actions. A card keeps its main action on the bar and puts
 * Skip and Mute PR in its menu; the modal keeps its actions beside findings.
 */
export function ReviewActions({
  r,
  canDraft,
  publish,
  split = false,
  inView = false,
  decisionSaving = false,
}: {
  r: GlassReview;
  canDraft: boolean;
  publish: boolean;
  /** A card's bar: the main action as a big button; Skip and Mute PR in its menu. */
  split?: boolean;
  /** View actions keep secondary choices in the split menu. */
  inView?: boolean;
  /** The PR view is saving an answer; post only once it reaches disk. */
  decisionSaving?: boolean;
}) {
  const [confirmApproval, setConfirmApproval] = useState(false);
  // The same review's action may be running from its item card.
  const pending = getState().reviewActions?.[r.key] ?? (itemEffectInFlight(r.key) as ReviewRequestKind | undefined);
  // A source without review actions may still dismiss or mute through its boat.
  if (!can('review-request')) {
    if (r.mutedAt) return html`<span class="rv-actions"><${MuteAction} r=${r} /></span>`;
    if (!split) return html`<${MuteAction} r=${r} />${can('review-dismiss') && html`<${Dismiss} r=${r} />`}`;
    const more: MenuAction[] = [];
    if (can('review-dismiss') && DISMISSABLE.includes(r.state)) {
      more.push({
        label: 'Dismiss',
        icon: ActionIcon.skip,
        title: 'Send the dismissal to the boat that drafted this review',
        action: async (e) => {
          e.stopPropagation();
          return dismissReview(r.key);
        },
        sending: 'Dismissing…',
        done: 'Sent to the boat that drafted it',
      });
    }
    const mute = muteMenuAction(r);
    if (mute) more.push(mute);
    return html`<span class=${'rv-actions' + (more.length ? ' rv-menu-only' : '')}>${more.length && html`<${SplitButton} more=${more.map((action) => ({ ...action, onError: showReviewError }))} />`}</span>`;
  }
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    return reviewRequest(kind, { key: r.key });
  };
  const approve: MenuAction = {
    label: 'Approve anyway',
    pending: pending === 'review-approve-anyway',
    disabled: !!pending,
    sending: 'Approving…',
    icon: ActionIcon.approve,
    onClick: (event: Event): void => {
      event.stopPropagation();
      setConfirmApproval(true);
    },
  };
  const updating = reviewUpdating(r);
  const drafting = r.state === 'drafting' || updating;
  const preparing = updating ? 'Updating…' : 'Preparing draft…';
  const canApprove = !drafting && ['open', 'draft'].includes(reviewPrState(r));
  const approvalMenu = canApprove ? [approve] : [];
  const confirmation =
    confirmApproval &&
    createPortal(
      html`<${Dialog} title=${`Approve #${r.number}?`} onClose=${() => setConfirmApproval(false)}>
    <p>Approve this PR without the draft’s comments or findings.</p>
    <div class="dialog-actions"><${Button} onClick=${() => setConfirmApproval(false)}>Cancel<//>
    <${Button} onError=${showReviewError} variant="primary" pending=${pending === 'review-approve-anyway'} disabled=${drafting || !!pending} sending="Approving…" action=${async (
      event: Event,
    ): Promise<string | undefined> => {
      event.stopPropagation();
      const why = await reviewRequest('review-approve-anyway', { key: r.key });
      if (!why) setConfirmApproval(false);
      return why;
    }}>Approve anyway<//></div>
  <//>`,
      document.body,
    );
  const send = SEND[r.verdict ?? 'comment'];
  const verdictDone =
    send.kind === 'review-approve'
      ? `Approved #${r.number}`
      : send.kind === 'review-request-changes'
        ? `Requested changes on #${r.number}`
        : `Published a comment on #${r.number}`;
  const done = (kind: ReviewRequestKind): string | undefined => {
    if (kind === 'review-approve' || kind === 'review-request-changes' || kind === 'review-comment') return verdictDone;
    if (kind === 'review-draft') return 'Draft ready';
    if (kind === 'review-redraft') return 'Draft requested';
    if (kind === 'review-skip') return 'Dismissed';
    return undefined;
  };
  const sending = (kind: ReviewRequestKind): string =>
    kind === 'review-approve'
      ? 'Approving…'
      : kind === 'review-request-changes'
        ? 'Requesting changes…'
        : kind === 'review-comment'
          ? 'Publishing…'
          : kind === 'review-skip'
            ? 'Skipping…'
            : 'Sending…';
  if (r.mutedAt)
    return html`<${MuteAction} r=${r} /><span class="rv-actions rv-menu-only"><${SplitButton} more=${approvalMenu} />${confirmation}</span>`;
  const postBlocked = r.state === 'drafted' && (decisionSaving || unansweredReviewDecisions(r).length > 0);
  const hasPublishAction = r.state === 'drafted' || drafting;
  const draftKind = r.state === 'stale' ? 'review-redraft' : 'review-draft';
  const sendButton =
    hasPublishAction &&
    html`<${Button} onError=${showReviewError} disabled=${drafting || postBlocked || !!pending} title=${drafting ? preparing : `Publish ${send.posts}`}  pending=${pending === send.kind} action=${act(send.kind)} sending=${sending(send.kind)} done=${done(send.kind)}>${drafting ? preparing : send.label}<//>`;
  if (split) {
    const drafts = (canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale';
    const skips = OPEN.has(r.state) || !!r.notification;
    const skipTitle =
      "Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub.";
    const main = hasPublishAction
      ? html`<${Button} onError=${showReviewError} size=${inView ? 'lg' : 'md'} variant="primary" disabled=${drafting || postBlocked || !!pending} title=${drafting ? preparing : `Publish ${send.posts}`}  pending=${pending === send.kind} action=${act(send.kind)} sending=${sending(send.kind)} done=${done(send.kind)}>${SEND_ICON[r.verdict ?? 'comment']}${drafting ? preparing : send.label}<//>`
      : drafts
        ? html`<${Button} onError=${showReviewError} size=${inView ? 'lg' : 'md'} variant="primary" pending=${pending === draftKind} disabled=${!!pending} action=${act(draftKind)} done=${done(draftKind)} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'}>${ActionIcon.draft}${r.state === 'stale' ? 'Re-draft' : publish ? 'Review (publish)' : 'Review (draft)'}<//>`
        : null;
    const more: MenuAction[] = [...approvalMenu];
    if (inView && r.state === 'dismissed')
      more.push({ label: 'New review', icon: ActionIcon.draft, action: act('review-new'), done: 'New review requested' });
    if (skips)
      more.push({
        label: inView ? 'Dismiss' : 'Skip',
        icon: ActionIcon.skip,
        title: skipTitle,
        action: act('review-skip'),
        pending: pending === 'review-skip',
        disabled: !!pending,
        sending: sending('review-skip'),
        done: done('review-skip'),
      });
    if (r.state === 'drafted' && !updating)
      more.push({ label: 'Re-draft', icon: ActionIcon.draft, action: act('review-redraft'), done: 'Draft requested' });
    const mute = muteMenuAction(r);
    if (mute) more.push(mute);
    return html`<span class=${'rv-actions' + (!main && more.length ? ' rv-menu-only' : '')}>${(main || more.length) && html`<${SplitButton} main=${main} more=${more.map((action) => ({ ...action, onError: showReviewError }))} />`}${confirmation}</span>`;
  }
  return html`<span class="rv-actions">
    ${!updating && ((canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale') && html`<${Button} onError=${showReviewError} pending=${pending === draftKind} disabled=${!!pending} action=${act(draftKind)} done=${done(draftKind)} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'}>${ActionIcon.draft}${r.state === 'stale' ? 'Re-draft' : publish ? 'Review (publish)' : 'Review (draft)'}<//>`}
    ${sendButton}
    ${r.state === 'drafted' && !updating && html`<${Button} onError=${showReviewError} pending=${pending === 'review-redraft'} disabled=${!!pending} action=${act('review-redraft')} done="Draft requested">Re-draft<//>`}
    <${SplitButton} more=${approvalMenu} />${confirmation}
    <${MuteAction} r=${r} />
    ${(OPEN.has(r.state) || r.notification) && html`<${Button} onError=${showReviewError} pending=${pending === 'review-skip'} disabled=${!!pending} sending=${sending('review-skip')} action=${act('review-skip')} done=${done('review-skip')} title="Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub.">Dismiss<//>`}
  </span>`;
}

/** Review tags use the same lifecycle colors and status renderer as PR cards and details. */
export function ReviewTags({ r, state = reviewPrState(r) }: { r: GlassReview; state?: PrIconState }): Children {
  const status = reviewStatus(r);
  return html`<${PrTags} state=${state} tags=${[
    { ...status, unread: !reviewUpdating(r) && !!reviewUnreadReason(r) },
    ...(r.mutedAt ? [{ word: 'muted', tone: 'dim' as const }] : []),
  ]} />`;
}

const badge = (r: GlassReview): Children => html`<${ReviewTags} r=${r} />`;
const findings = (r: GlassReview) =>
  html`${r.summary && html`<details onClick=${(e: Event) => e.stopPropagation()}><summary>Summary</summary><div class="rv-reason">${r.summary}</div></details>`}${r.blocking?.map((b) => html`<div class="rv-reason bad">${b.path}:${b.line} · ${b.body}</div>`)}`;

export { initials } from './card.js';

/** Who asked for a review, as its card's avatar chip shows them. */
export function reviewPerson(r: GlassReview): CardPerson {
  const login = r.asker ?? r.requestedBy ?? r.author;
  return {
    login,
    ...(r.askerName ? { name: r.askerName } : {}),
    ...(r.askerAvatarUrl ? { avatarUrl: r.askerAvatarUrl } : githubAvatarUrl(login) ? { avatarUrl: githubAvatarUrl(login) } : {}),
    role: 'requested by',
  };
}

const asker = (r: GlassReview) => html`<span class="rv-person" title=${r.asker ?? r.requestedBy ?? r.author}>
  ${r.askerAvatarUrl && html`<${Avatar} url=${r.askerAvatarUrl} name=${r.askerName ?? r.asker ?? r.requestedBy ?? r.author} />`}
  <span>${r.askerName ?? r.asker ?? r.requestedBy ?? r.author}</span>
  ${r.automatic && html`${StatusChip('automatic', 'dim', 'A bot re-requested this review')}`}
</span>`;

const staged = (r: GlassReview) =>
  r.staged &&
  html`<a class="rv-staged" href=${r.stagedReviewUrl ?? r.reviewUrl} target="_blank" rel="noopener" onClick=${(event: Event) => event.stopPropagation()}>Open draft</a>`;

/** Read the same PR authorization that the PRs page renders. */
const mergePr = (r: GlassReview) => getState().snapshot?.prs.find((p) => p.key === r.key.replace(/^review:/, 'pr:'));

function row(r: GlassReview, canDraft: boolean, publish: boolean) {
  return html`<tr key=${r.key} id=${'review-' + encodeURIComponent(r.key)} data-review=${r.key} class=${'rowhead' + (r.seenAt || r.acknowledgedAt ? ' seen' : !OPEN.has(r.state) ? ' acked' : '')} onClick=${showReview(r)}>
    <td><a href=${r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => {
      e.stopPropagation();
      showReview(r)();
      e.preventDefault();
    }}><${PrStateIcon} state=${reviewPrState(r)} /> ${r.repo}#${r.number}</a></td>
    <td class="grow">${r.title}${findings(r)}</td>
    <td>${r.author}</td>
    <td>${asker(r)}</td>
    <td>${Age(r.requestedAt)}</td>
    <td>${badge(r)} ${posted(r)}<${MergeIntent} p=${mergePr(r)} />${mergePr(r)?.mergeRequest && html`<${MergeWhenGreen} p=${mergePr(r)} />`}</td>
    <td><${ReviewActions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} /></td>
  </tr>`;
}

/** A posted review's verdict, as its card's status. */
const POSTED: Record<string, string> = { approve: 'approved', request_changes: 'changes requested' };
const posted = (r: GlassReview) =>
  r.postedAt &&
  html`<a href=${r.postedReviewUrl ?? r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>Posted ${Age(r.postedAt)}</a>`;

/**
 * A review's status, as its card's chip says it: "draft ready" once drafted;
 * "approved" or "changes requested" once posted with that verdict, else
 * "posted"; otherwise its round's state (requested, drafting, stale, failed).
 */
export function reviewStatus(
  r: Pick<
    GlassReview,
    'state' | 'staged' | 'verdict' | 'decisions' | 'decisionAnswers' | 'reReview' | 'autoReapproved' | 'updating' | 'reason'
  >,
): {
  word: string;
  tone: CardTone;
} {
  if (reviewUpdating(r)) return { word: 'Updating', tone: 'dim' };
  if (r.reReview) return { word: 're-review needed', tone: 'bad' };
  if (r.autoReapproved) return { word: 'automatically re-approved', tone: 'ok' };
  if (reviewState(r) === 'needs your call') return { word: 'needs your call', tone: 'bad' };
  if (r.state === 'drafted') return { word: 'Ready to post', tone: 'ok' };
  if (r.state === 'posted')
    return { word: (r.verdict && POSTED[r.verdict]) || 'posted', tone: r.verdict === 'request_changes' ? 'warn' : 'ok' };
  if (r.state === 'failed') return { word: 'failed', tone: 'bad' };
  if (['dismissed', 'withdrawn', 'merged', 'closed'].includes(r.state)) return { word: r.state, tone: 'dim' };
  return { word: reviewState(r), tone: 'warn' };
}

/** Red when it waits on you or failed, amber while lobstah works on it, green once posted, grey once closed another way. */
function reviewTone(r: GlassReview): CardTone {
  if (reviewUpdating(r)) return 'dim';
  if (r.reReview) return 'bad';
  if (r.state === 'posted') return 'ok';
  if (['dismissed', 'withdrawn', 'merged', 'closed'].includes(r.state)) return 'dim';
  if (unansweredReviewDecisions(r).length || r.needsYou || r.stands || r.state === 'failed') return 'bad';
  return 'warn';
}

/** Acknowledge the notification state shown, keeping the pending review intact. */
export function markReviewOpened(r: GlassReview): void {
  if (!reviewUnreadReason(r)) return;
  const attention = getState().snapshot?.attention.find((a) => a.kind === 'review' && a.key === r.key);
  if (attention && !attention.acked) hideLob(attention.key, attention.stateHash);
  else void reviewRequest('review-seen', { key: r.key });
}

/** Opening a review clears its notification and opens the PR view. */
const showReview = (r: GlassReview) => () => {
  showModal('review', r.key);
};

/**
 * A review card, in the PR card's layout (prShapedCard): the PR icon and
 * title; the PR lifecycle and review status tags;
 * then repo · age · #number · 🪤 the trap drafting it; then its main action
 * as a big button (draft, or send the drafted verdict) with Skip in its ▾
 * menu, or dismiss on a wharf; then the Open icon at the bar's right, named
 * Open draft once there is one. Who asked, the findings and the reason are in its modal.
 */
function card(r: GlassReview, canDraft: boolean, publish: boolean) {
  const draft = r.staged ? (r.stagedReviewUrl ?? r.reviewUrl) : undefined;
  const open = showReview(r);
  return prShapedCard({
    key: r.key,
    title: r.title,
    titleAttr: r.title,
    prState: reviewPrState(r),
    status: [html`<${ReviewTags} r=${r} />`, posted(r)],
    tail: html`<${MergeIntent} p=${mergePr(r)} />`,
    tone: reviewTone(r),
    repo: r.repo,
    number: r.number,
    at: r.requestedAt,
    trap: dispatchTrap([r.dispatch]),
    person: reviewPerson(r),
    actions: [
      mergePr(r)?.mergeRequest && html`<${MergeWhenGreen} p=${mergePr(r)} />`,
      html`<${ReviewActions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} split />`,
      html`<${CardLink} href=${draft ?? r.reviewUrl} label=${draft ? 'Open draft' : 'Open'} onOpen=${() => {
        markReviewOpened(r);
      }} />`,
    ],
    quiet: !OPEN.has(r.state),
    cls: 'rv-card' + (r.seenAt || r.acknowledgedAt ? ' seen' : ''),
    attrs: {
      id: 'review-' + encodeURIComponent(r.key),
      'data-review': r.key,
      role: 'button',
      tabindex: '0',
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      },
    },
    onClick: open,
  });
}

/** What leaves a review's card: the asker, findings, reason, pending review and every action. */
export function reviewModal(r: GlassReview) {
  const setup = getState().snapshot?.reviewSetup;
  const effective = (r.repoKey && setup?.perRepo?.[r.repoKey]) || setup;
  const meta = reviewMeta(r);
  return [
    html`<h3><a href=${r.reviewUrl} target="_blank" rel="noopener" onClick=${() => void reviewRequest('review-seen', { key: r.key })}>${r.repo}#${r.number}</a> ${r.title} ${badge(r)}</h3>`,
    html`<div class="sub" title=${meta.text}>${meta.nodes}</div>`,
    html`<div class="sec">asked by</div><div class="rv-asker">${asker(r)}</div>`,
    (r.summary || r.blocking?.length) && html`<div class="sec">findings</div>${findings(r)}`,
    r.staged && html`<div class="sec">pending review</div><div>${staged(r)}</div>`,
    r.postedAt && html`<div class="sec">posted review</div><div>${posted(r)}</div>`,
    html`<div class="sec">actions</div><div class="rv-modal-actions"><${ReviewActions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : effective?.mode !== 'notify'} publish=${r.publish ?? effective?.publish ?? false} /></div>`,
  ];
}

/** The mode names shown beside read-only review settings. */
const REVIEW_MODE_LABELS: Record<NonNullable<GlassSnapshot['reviewSetup']>['mode'], string> = {
  notify: 'Notify',
  'on-demand': 'On-demand',
  'auto-draft': 'Auto draft',
  'auto-review': 'Auto review',
};

/** The read-only review settings line, or how to turn reviews on. */
function reviewSettingsLine(setup: GlassSnapshot['reviewSetup'], repo: string): Children {
  const effective = (repo && setup?.perRepo?.[repo]) || setup;
  const publish = effective?.publish ?? false;
  return setup?.enabled
    ? html`<div class="rv-controls"><span>Review mode · ${repo || 'default'}: ${REVIEW_MODE_LABELS[effective?.mode ?? 'notify']}</span><span>Publish: ${publish ? 'on' : 'off'}</span><span class="dim">${setup.identity ?? 'GitHub identity'} · pick ${setup.running ? 'running' : 'not running'} · read-only</span></div>`
    : html`<div class="empty">Enable review notifications: <code>lobstah setup reviews</code></div>`;
}

/** GitHub's read-only settings beside other review sources: named as GitHub's, with setup as a quiet line. */
function githubSettingsLine(setup: GlassSnapshot['reviewSetup'], repo: string): Children {
  if (!setup?.enabled)
    return html`<div class="rv-controls dim"><span>GitHub reviews are off: <code>lobstah setup reviews</code></span></div>`;
  const effective = (repo && setup.perRepo?.[repo]) || setup;
  return html`<div class="rv-controls"><span>GitHub settings · Review mode · ${repo || 'default'}: ${REVIEW_MODE_LABELS[effective?.mode ?? 'notify']}</span><span>Publish: ${effective?.publish ? 'on' : 'off'}</span><span class="dim">${setup.identity ?? 'GitHub identity'} · pick ${setup.running ? 'running' : 'not running'} · read-only</span></div>`;
}

/** The review sources this page knows, by ID, in a stable order: those with items or health, named by their brand. */
function reviewSourceList(inp: SectionInputs['reviews']): WatchSurfaceItem['source'][] {
  const byId = new Map<string, WatchSurfaceItem['source']>();
  for (const entry of [...(inp.sources ?? []), ...(inp.items ?? [])])
    if (!byId.has(entry.source.id)) byId.set(entry.source.id, entry.source);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Choose every source or one: the same segmented control Traps groups with. */
function ReviewSourceFilter({ sources, chosen }: { sources: WatchSurfaceItem['source'][]; chosen?: string }): Children {
  return html`<div class="tabhead rv-sources"><div class="seg" role="group" aria-label="Review source">
    <${Button} pressed=${!chosen} onClick=${() => setPrefs({ reviewSource: undefined })}>All sources<//>
    ${sources.map((source) => html`<${Button} key=${source.id} pressed=${chosen === source.id} onClick=${() => setPrefs({ reviewSource: source.id })}>${source.name}<//>`)}
  </div></div>`;
}

/** A section's contents and its heading: Needs your review stays open; the others remember being opened. */
function reviewSection(
  id: 'needs' | 'waiting' | 'done',
  title: string,
  count: number,
  empty: boolean,
  contents: Children,
  expanded: SectionInputs['reviews']['expanded'],
): Children {
  return id === 'needs'
    ? html`<section class="rv-section" data-review-section=${id}><h2>${title} (${count})</h2>${empty ? html`<p class="empty">No reviews need you</p>` : contents}</section>`
    : html`<details class="rv-section" data-review-section=${id} open=${expanded?.[id] === true} onToggle=${(event: Event) => {
        const open = (event.currentTarget as HTMLDetailsElement).open;
        if ((getState().prefs.reviewSections?.[id] === true) !== open)
          setPrefs({ reviewSections: { ...getState().prefs.reviewSections, [id]: open } });
      }}><summary>${title} (${count})</summary>${contents}</details>`;
}

/**
 * Review requests from every review-capable source, through the shared item
 * slots, and the current repo's settings; all settings are read-only. An
 * older boat that sends only the legacy records renders them as before.
 */
export function Reviews({ inp, setup, repo = '' }: { inp: SectionInputs['reviews']; setup?: GlassSnapshot['reviewSetup']; repo?: string }) {
  if (inp.items) return ItemReviews({ inp: { ...inp, items: inp.items }, setup, repo });
  const effective = (repo && setup?.perRepo?.[repo]) || setup;
  const canDraft = effective?.mode !== 'notify';
  const publish = effective?.publish ?? false;
  return [
    reviewSettingsLine(setup, repo),
    ...reviewSections(inp.list).map(({ id, title, groups, count }) => {
      const contents = groups.map(
        ({ stack, reviews }) =>
          html`<section class="rv-group">${
            stack
              ? html`<${StackCard}
              id=${`review-stack:${stack.id}`}
              prState=${reviews.some((review) => ['open', 'draft'].includes(reviewPrState(review))) ? 'open' : reviews.some((review) => reviewPrState(review) === 'merged') ? 'merged' : 'closed'}
              repo=${reviews[0]!.repoKey ?? reviews[0]!.repo}
              updatedAt=${reviews
                .map((review) => review.updatedAt ?? review.postedAt ?? review.draftedAt ?? review.requestedAt)
                .sort()
                .at(-1)}
              range=${reviews.length === 1 ? `#${reviews[0]!.number}` : `#${reviews[0]!.number} → #${reviews.at(-1)!.number}`}
              header=${{
                title: stack.title ?? reviews.at(-1)!.title,
                titleAttr: stack.title ?? reviews.at(-1)!.title,
                attrs: { 'data-review-stack': stack.id, 'aria-label': stack.title ?? reviews.at(-1)!.title },
              }}
              members=${() => reviews.map((review) => card(review, canDraft, publish))}
            />`
              : inp.view === 'cards'
                ? html`<div class="cards">${reviews.map((review) => card(review, canDraft, publish))}</div>`
                : Table(
                    ['PR', 'title', 'author', 'asked by', 'asked', 'state', ''],
                    reviews.map((review) => row(review, canDraft, publish)),
                    'no review requests match',
                  )
          }</section>`,
      );
      return reviewSection(id, title, count, !groups.length, contents, inp.expanded);
    }),
  ];
}

/** An item's metadata value of one kind. */
const metadataValue = (entry: WatchSurfaceItem, kind: string): string | undefined =>
  entry.item.metadata.find((value) => value.kind === kind)?.value;

/** Where a review item's own page is: its Open link. */
const itemHref = (entry: WatchSurfaceItem): string | undefined => {
  const open = entry.item.actions.find((action) => action.placement === 'open' && 'link' in action.binding);
  return open && 'link' in open.binding ? targetHref(open.binding.link) : targetHref(entry.item.target);
};

/** The item's reference as the table's first column shows it: `owner/repo#12`, or `project · plan r2`. */
function itemReference(entry: WatchSurfaceItem): string {
  const project = metadataValue(entry, 'project');
  const reference = metadataValue(entry, 'reference');
  if (!project) return reference ?? entry.item.title;
  if (!reference) return project;
  return reference.startsWith('#') ? `${project}${reference}` : `${project} · ${reference}`;
}

/** A row's notes: a labelled note collapses under its label; a finding is one line in its tone. */
const itemNotes = (entry: WatchSurfaceItem): Children =>
  (entry.item.notes ?? []).map((note) =>
    note.label
      ? html`<details onClick=${(e: Event) => e.stopPropagation()}><summary>${note.label}</summary><div class="rv-reason">${note.text}</div></details>`
      : html`<div class=${'rv-reason' + (note.meaning === 'failed' || note.meaning === 'needs-you' ? ' bad' : '')}>${note.text}</div>`,
  );

/** Who asked, as the table's and detail's asker cell shows them. */
function itemAsker(entry: WatchSurfaceItem): Children {
  const person = entry.item.person;
  if (!person) return null;
  return html`<span class="rv-person" title=${person.id}>
    ${person.avatarUrl && html`<${Avatar} url=${person.avatarUrl} name=${person.name ?? person.id} />`}
    <span>${person.name ?? person.id}</span>
    ${person.badge && StatusChip(person.badge.label, 'dim', person.badge.detail)}
  </span>`;
}

/** One review item as a table row: the same columns the review table had. */
function itemRow(entry: WatchSurfaceItem): Children {
  const { item } = entry;
  const open = () => openItemTarget(item.target);
  return html`<tr key=${`${entry.watch.key}:${item.id}`} id=${'review-' + encodeURIComponent(item.id)} data-review=${item.id} class=${'rowhead' + (item.notification?.seen ? ' seen' : item.resolved ? ' acked' : '')} onClick=${open}>
    <td><a href=${itemHref(entry)} target="_blank" rel="noopener" onClick=${(e: Event) => {
      e.stopPropagation();
      open();
      e.preventDefault();
    }}><${ItemGlyph} item=${item} /> ${itemReference(entry)}</a></td>
    <td class="grow">${item.title}${itemNotes(entry)}</td>
    <td>${item.metadata.find((value) => value.kind === 'person')?.value}</td>
    <td>${itemAsker(entry)}</td>
    <td>${item.requestedAt && Age(item.requestedAt)}</td>
    <td><${ItemStatuses} item=${item} /></td>
    <td><${ItemActions} entry=${entry} open=${false} /></td>
  </tr>`;
}

/** One review item as a card in the shared slots; it opens where its source points. */
const itemCard = (entry: WatchSurfaceItem): Children =>
  watchItemCard(entry, {
    onOpen: () => openItemTarget(entry.item.target),
    cls: 'rv-card',
    attrs: { id: 'review-' + encodeURIComponent(entry.item.id), 'data-review': entry.item.id },
  });

/** Items in list order, grouped as their source groups them: a group's members stay together, bottom first. */
export function itemGroups(
  entries: readonly WatchSurfaceItem[],
): Array<{ group?: { id: string; title?: string }; entries: WatchSurfaceItem[] }> {
  const groups: Array<{ group?: { id: string; title?: string }; entries: WatchSurfaceItem[] }> = [];
  const seen = new Set<WatchSurfaceItem>();
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    const group = entry.item.group;
    const members = group
      ? entries
          .filter((candidate) => candidate.watch.key === entry.watch.key && candidate.item.group?.id === group.id)
          .sort((a, b) => (a.item.group?.position ?? Infinity) - (b.item.group?.position ?? Infinity))
      : [entry];
    members.forEach((member) => seen.add(member));
    const previous = groups.at(-1);
    if (!group && previous && !previous.group) previous.entries.push(entry);
    else groups.push({ ...(group ? { group } : {}), entries: members });
  }
  return groups;
}

/** Needs your review, Waiting on response, Done: a group follows its most urgent item; counts are items that wait on you. */
export function itemSections(
  entries: readonly WatchSurfaceItem[],
  /** Several sources: unread items that wait on you lead each section, then the newest; GitHub-only keeps its recency order. */
  mixed = false,
): Array<{
  id: 'needs' | 'waiting' | 'done';
  title: string;
  groups: ReturnType<typeof itemGroups>;
  count: number;
}> {
  const sections = [
    { id: 'needs' as const, title: 'Needs your review', groups: [] as ReturnType<typeof itemGroups>, count: 0 },
    { id: 'waiting' as const, title: 'Waiting on response', groups: [] as ReturnType<typeof itemGroups>, count: 0 },
    { id: 'done' as const, title: 'Done', groups: [] as ReturnType<typeof itemGroups>, count: 0 },
  ];
  const urgency = ({ item }: WatchSurfaceItem): number =>
    item.lifecycle.phase === 'completed' || item.lifecycle.phase === 'closed' ? 2 : item.answered ? 1 : 0;
  const recent = ({ item }: WatchSurfaceItem): string => item.updatedAt ?? item.requestedAt ?? '';
  const groups = itemGroups(entries).flatMap((group) => (group.group ? [group] : group.entries.map((entry) => ({ entries: [entry] }))));
  const waiting = (group: { entries: WatchSurfaceItem[] }): number =>
    Number(mixed && group.entries.some(({ item }) => item.standing && item.notification?.unread));
  const latest = (group: { entries: WatchSurfaceItem[] }): string => group.entries.map(recent).sort().at(-1) ?? '';
  const id = (group: { entries: WatchSurfaceItem[] }): string => group.entries[0]!.item.id;
  groups.sort(
    (left, right) => waiting(right) - waiting(left) || latest(right).localeCompare(latest(left)) || id(left).localeCompare(id(right)),
  );
  for (const group of groups) {
    const section = sections[Math.min(...group.entries.map(urgency))]!;
    const previous = section.groups.at(-1);
    if (!('group' in group && group.group) && previous && !previous.group) previous.entries.push(...group.entries);
    else section.groups.push(group);
    section.count += group.entries.filter((entry) => entry.item.standing).length;
  }
  return sections;
}

/** The lifecycle a group card shows: open while any member is active or draft, else merged, else closed. */
function groupState(entries: readonly WatchSurfaceItem[]): 'open' | 'merged' | 'closed' {
  if (entries.some(({ item }) => item.lifecycle.phase === 'active' || item.lifecycle.phase === 'draft')) return 'open';
  return entries.some(({ item }) => item.lifecycle.phase === 'completed') ? 'merged' : 'closed';
}

/** Reviews from items: the same sections, stacks, cards and table as before, for every source. */
function ItemReviews({
  inp,
  setup,
  repo,
}: {
  inp: SectionInputs['reviews'] & { items: WatchSurfaceItem[] };
  setup?: GlassSnapshot['reviewSetup'];
  repo: string;
}) {
  const kinds = new Set(inp.items.map((entry) => entry.item.kind));
  const first = kinds.size === 1 && kinds.has('pull-request') ? 'PR' : 'item';
  const sources = reviewSourceList(inp);
  const others = sources.some((source) => source.id !== 'github');
  return [
    // The read-only settings are GitHub's; with other sources they say so, and turning GitHub on is not a page-wide error.
    others ? githubSettingsLine(setup, repo) : reviewSettingsLine(setup, repo),
    sources.length > 1 && html`<${ReviewSourceFilter} sources=${sources} chosen=${inp.source} />`,
    ...(inp.sources ?? [])
      .filter((entry) => entry.health !== 'healthy' && (!inp.source || entry.source.id === inp.source))
      .map(
        (entry) =>
          html`<p class="rv-source-notice" data-review-source=${entry.source.id}><span class="glead"><${SourceLogo} source=${entry.source} /></span><b>${entry.source.name}</b> · ${entry.health === 'held' ? 'stopped' : 'not up to date'}${entry.message && ` · ${entry.message}`}${entry.remedy && html` <span class="dim">${entry.remedy}</span>`}</p>`,
      ),
    ...itemSections(inp.items, sources.length > 1).map(({ id, title, groups, count }) => {
      const contents = groups.map(({ group, entries }) => {
        const last = entries.at(-1)!;
        const references = entries.map((entry) => metadataValue(entry, 'reference')).filter(Boolean) as string[];
        return html`<section class="rv-group">${
          group
            ? html`<${StackCard}
                id=${`review-stack:${group.id}`}
                prState=${groupState(entries)}
                repo=${entries[0]!.item.repo ?? metadataValue(entries[0]!, 'project') ?? ''}
                updatedAt=${entries
                  .map(({ item }) => item.updatedAt ?? item.requestedAt)
                  .filter(Boolean)
                  .sort()
                  .at(-1)}
                range=${references.length === 1 ? references[0] : references.length ? `${references[0]} → ${references.at(-1)}` : undefined}
                header=${{
                  title: group.title ?? last.item.title,
                  titleAttr: group.title ?? last.item.title,
                  attrs: { 'data-review-stack': group.id, 'aria-label': group.title ?? last.item.title },
                }}
                members=${() => entries.map(itemCard)}
              />`
            : inp.view === 'cards'
              ? html`<div class="cards">${entries.map(itemCard)}</div>`
              : Table([first, 'title', 'author', 'asked by', 'asked', 'state', ''], entries.map(itemRow), 'no review requests match')
        }</section>`;
      });
      return reviewSection(id, title, count, !groups.length, contents, inp.expanded);
    }),
  ];
}

/** Group visible reviews using the watch detector's order; standalone PRs retain their layout. */
export function reviewGroups(reviews: readonly GlassReview[]): Array<{ stack?: GlassReview['stack']; reviews: GlassReview[] }> {
  const groups: Array<{ stack?: GlassReview['stack']; reviews: GlassReview[] }> = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    if (seen.has(review.key)) continue;
    const members = review.stack ? review.stack.keys.flatMap((key) => reviews.filter((candidate) => candidate.key === key)) : [review];
    members.forEach((member) => seen.add(member.key));
    const previous = groups.at(-1);
    if (!review.stack && previous && !previous.stack) previous.reviews.push(review);
    else groups.push({ stack: review.stack, reviews: members });
  }
  return groups;
}

/** Actionable reviews stay counted after opening; automatic work and waiting rounds do not. */
export function reviewNeedsViewer(review: GlassReview): boolean {
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

/** A whole stack follows its most urgent PR, so its review order stays intact. */
export function reviewSections(reviews: readonly GlassReview[]): Array<{
  id: 'needs' | 'waiting' | 'done';
  title: string;
  groups: ReturnType<typeof reviewGroups>;
  count: number;
}> {
  const sections = [
    { id: 'needs' as const, title: 'Needs your review', groups: [] as ReturnType<typeof reviewGroups>, count: 0 },
    { id: 'waiting' as const, title: 'Waiting on response', groups: [] as ReturnType<typeof reviewGroups>, count: 0 },
    { id: 'done' as const, title: 'Done', groups: [] as ReturnType<typeof reviewGroups>, count: 0 },
  ];
  const urgency = (review: GlassReview): number => {
    if (['MERGED', 'CLOSED'].includes(review.prState ?? '') || ['merged', 'closed'].includes(review.state)) return 2;
    return review.state === 'posted' && !review.reReview ? 1 : 0;
  };
  const recent = (review: GlassReview): string => review.updatedAt ?? review.postedAt ?? review.requestedAt;
  // Keep standalone reviews independent while assigning urgency, then coalesce their layouts.
  const groups = reviewGroups(reviews).flatMap((group) => (group.stack ? [group] : group.reviews.map((review) => ({ reviews: [review] }))));
  groups.sort((left, right) => {
    const latest = (group: { reviews: GlassReview[] }): string => group.reviews.map(recent).sort().at(-1) ?? '';
    return latest(right).localeCompare(latest(left));
  });
  for (const group of groups) {
    const section = sections[Math.min(...group.reviews.map(urgency))]!;
    const previous = section.groups.at(-1);
    if (!('stack' in group && group.stack) && previous && !previous.stack) previous.reviews.push(...group.reviews);
    else section.groups.push(group);
    section.count += group.reviews.filter(reviewNeedsViewer).length;
  }
  return sections;
}
