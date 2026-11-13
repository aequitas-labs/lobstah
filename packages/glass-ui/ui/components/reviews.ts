import type { GlassReview, GlassSnapshot } from '@lobstah/core';
import type { SectionInputs } from '../../src/glass-diff.js';
import { dismissReview, muteReviewPr, reviewRequest, showModal, unmuteReviewPr } from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html } from '../html.js';
import { Age, Table, ageText } from './common.js';
import { can } from '../backend.js';
import { getState } from '../store.js';
import { ActionIcon, Avatar, CardLink, githubAvatarUrl, SplitButton } from './card.js';
import type { CardPerson, CardTone } from './card.js';
import type { MenuAction } from './card.js';
import { StatusChip, dispatchTrap, prShapedCard } from './prs.js';
import { Button } from './button.js';

/**
 * The Reviews tab: one row or card per PR that asked for your review,
 * the ones waiting on him first. A row opens the PR in its review tool
 * ([repos.<key>].reviewTool), where the drafted review waits as the identity's pending
 * review, to edit and send. A card opens the review's modal, with who asked,
 * the findings, the reason and the actions; its Open draft goes to the review
 * tool. On-demand jobs follow the repo’s draft/publish setting.
 */

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
const TONE: Record<string, string> = { drafted: 'ok', stale: 'warn', failed: 'bad', posted: 'dim', dismissed: 'dim', withdrawn: 'dim' };

/** The state as a person reads it: a staged draft is waiting in the review tool. */
export const reviewState = (r: Pick<GlassReview, 'state' | 'staged'>): string => r.state;

export const openReview = (r: Pick<GlassReview, 'reviewUrl'> & { key?: string }) => () => {
  if (r.key) void reviewRequest('review-seen', { key: r.key });
  window.open(r.reviewUrl, '_blank', 'noopener');
};

/** The meta line: who asked, when, and why the round is where it is. */
export function reviewMeta(r: GlassReview): { nodes: unknown[]; text: string } {
  const asked =
    r.askerName || r.asker || r.requestedBy
      ? `asked by ${r.askerName ?? r.asker ?? r.requestedBy}${r.automatic ? ' (automatic)' : ''}`
      : 'review requested';
  return {
    nodes: [r.repo, '#', String(r.number), ' · ', asked, ' · ', Age(r.requestedAt), ' ago', r.reason ? ` · ${r.reason}` : ''],
    text: [`${r.repo}#${r.number}`, asked, `${ageText(r.requestedAt)} ago`, r.reason ?? ''].filter(Boolean).join(' · '),
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
  return html`<${Button} action=${dismiss} done="Sent to the boat that drafted it">Dismiss<//>`;
}

/** Mute or unmute every review round for this PR. */
function MuteAction({ r }: { r: GlassReview }) {
  if (r.mutedAt ? !can('review-unmute') : !can('review-mute')) return null;
  const change = async (e: Event) => {
    e.stopPropagation();
    return r.mutedAt ? unmuteReviewPr(r.key) : muteReviewPr(r.key);
  };
  return html`<${Button} action=${change} done=${r.mutedAt ? 'Unmuted' : 'Muted'}>${r.mutedAt ? 'Unmute' : 'Mute this PR'}<//>`;
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
  approve: { kind: 'review-approve', label: 'Approve', posts: 'approval' },
  request_changes: { kind: 'review-request-changes', label: 'Request changes', posts: 'changes request' },
  comment: { kind: 'review-comment', label: 'Publish comment', posts: 'comment' },
} as const satisfies Record<string, { kind: ReviewRequestKind; label: string; posts: string }>;

/** The icon beside each verdict's send button: approve, request changes, publish a comment. */
const SEND_ICON = { approve: ActionIcon.approve, request_changes: ActionIcon.changes, comment: ActionIcon.publish } as const;

/**
 * The review's actions. A card keeps its main action on the bar and puts
 * Skip and Mute PR in its menu; the modal keeps its actions beside findings.
 */
function Actions({
  r,
  canDraft,
  publish,
  split = false,
}: {
  r: GlassReview;
  canDraft: boolean;
  publish: boolean;
  /** A card's bar: the main action as a big button; Skip and Mute PR in its menu. */
  split?: boolean;
}) {
  // A source without review actions may still dismiss or mute through its boat.
  if (!can('review-request')) {
    if (r.mutedAt) return html`<span class="rv-actions"><span class="badge dim">Muted</span><${MuteAction} r=${r} /></span>`;
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
    return html`<span class=${'rv-actions' + (more.length ? ' rv-menu-only' : '')}>${more.length && html`<${SplitButton} more=${more} />`}</span>`;
  }
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    return reviewRequest(kind, { key: r.key });
  };
  const send = SEND[r.verdict ?? 'comment'];
  const verdictDone =
    send.kind === 'review-approve'
      ? `Approved #${r.number}`
      : send.kind === 'review-request-changes'
        ? `Requested changes on #${r.number}`
        : `Published a comment on #${r.number}`;
  const done = (kind: ReviewRequestKind): string | undefined => {
    if (kind === 'review-approve' || kind === 'review-request-changes' || kind === 'review-comment') return verdictDone;
    if (kind === 'review-draft' || kind === 'review-redraft') return 'Draft ready';
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
  if (r.mutedAt) return html`<span class="rv-actions"><span class="badge dim">Muted</span><${MuteAction} r=${r} /></span>`;
  const sendButton =
    r.state === 'drafted' &&
    html`<${Button} action=${act(send.kind)} sending=${sending(send.kind)} done=${done(send.kind)}>${send.label}<//>`;
  if (split) {
    const drafts = (canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale';
    const skips = OPEN.has(r.state) || !!r.notification;
    const skipTitle =
      "Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub.";
    const main =
      r.state === 'drafted'
        ? html`<${Button} variant="primary" action=${act(send.kind)} sending=${sending(send.kind)} done=${done(send.kind)}>${SEND_ICON[r.verdict ?? 'comment']}${send.label}<//>`
        : drafts
          ? html`<${Button} variant="primary" action=${act('review-draft')} done=${done('review-draft')} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'}>${ActionIcon.draft}${r.state === 'stale' ? 'Redraft' : publish ? 'Review (publish)' : 'Review (draft)'}<//>`
          : null;
    const more: MenuAction[] = [];
    if (skips)
      more.push({
        label: 'Skip',
        icon: ActionIcon.skip,
        title: skipTitle,
        action: act('review-skip'),
        sending: sending('review-skip'),
        done: done('review-skip'),
      });
    const mute = muteMenuAction(r);
    if (mute) more.push(mute);
    return html`<span class=${'rv-actions' + (!main && more.length ? ' rv-menu-only' : '')}>${(main || more.length) && html`<${SplitButton} main=${main} more=${more} />`}</span>`;
  }
  return html`<span class="rv-actions">
    ${((canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale') && html`<${Button} action=${act('review-draft')} done=${done('review-draft')} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'}>${r.state === 'stale' ? 'Redraft' : publish ? 'Review (publish)' : 'Review (draft)'}<//>`}
    ${sendButton}
    <${MuteAction} r=${r} />
    ${(OPEN.has(r.state) || r.notification) && html`<${Button} action=${act('review-skip')} done=${done('review-skip')} title="Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub.">Dismiss<//>`}
  </span>`;
}

const badge = (r: GlassReview) =>
  html`<span class=${'badge ' + (TONE[r.state] ?? '')}>${reviewState(r)}</span>${r.verdict && html`<span class="badge">${r.verdict.replace('_', ' ')}</span>`}${r.needsYou && html`<span class="badge warn">needs you</span>`}`;
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
  ${r.automatic && html`<span class="badge dim" title="A bot re-requested this review">automatic</span>`}
</span>`;

const staged = (r: GlassReview) =>
  r.staged &&
  html`<a class="rv-staged" href=${r.stagedReviewUrl ?? r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => {
    e.stopPropagation();
    void reviewRequest('review-seen', { key: r.key });
  }}>Open pending review</a>`;

function row(r: GlassReview, canDraft: boolean, publish: boolean) {
  return html`<tr key=${r.key} id=${'review-' + encodeURIComponent(r.key)} data-review=${r.key} class=${'rowhead' + (r.seenAt ? ' seen' : !OPEN.has(r.state) ? ' acked' : '')} onClick=${openReview(r)}>
    <td><a href=${r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => {
      e.stopPropagation();
      void reviewRequest('review-seen', { key: r.key });
    }}>${r.repo}#${r.number}</a></td>
    <td class="grow">${r.title}${findings(r)}</td>
    <td>${r.author}</td>
    <td>${asker(r)}</td>
    <td>${Age(r.requestedAt)}</td>
    <td>${badge(r)} ${staged(r)} ${posted(r)}</td>
    <td><${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} /></td>
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
export function reviewStatus(r: Pick<GlassReview, 'state' | 'staged' | 'verdict'>): { word: string; tone: CardTone } {
  if (r.state === 'drafted') return { word: 'draft ready', tone: 'ok' };
  if (r.state === 'posted')
    return { word: (r.verdict && POSTED[r.verdict]) || 'posted', tone: r.verdict === 'request_changes' ? 'warn' : 'ok' };
  if (r.state === 'failed') return { word: 'failed', tone: 'bad' };
  if (r.state === 'dismissed' || r.state === 'withdrawn') return { word: r.state, tone: 'dim' };
  return { word: reviewState(r), tone: 'warn' };
}

/** Red when it waits on you or failed, amber while lobstah works on it, green once posted, grey once closed another way. */
function reviewTone(r: GlassReview): CardTone {
  if (r.state === 'posted') return 'ok';
  if (r.state === 'dismissed' || r.state === 'withdrawn') return 'dim';
  if (r.needsYou || r.stands || r.state === 'failed') return 'bad';
  return 'warn';
}

/** Open the review's modal, and mark it seen. */
const showReview = (r: GlassReview) => () => {
  void reviewRequest('review-seen', { key: r.key });
  showModal('review', r.key);
};

/**
 * A review card, in the PR card's layout (prShapedCard): the PR icon and
 * title; the review's status chip, and "needs you" when it waits on you;
 * then repo · age · #number · 🪤 the trap drafting it; then its main action
 * as a big button (draft, or send the drafted verdict) with Skip in its ▾
 * menu, or dismiss on a wharf; then the Open icon at the bar's right, named
 * Open draft once there is one. Who asked, the findings and the reason are in its modal.
 */
function card(r: GlassReview, canDraft: boolean, publish: boolean) {
  const draft = r.staged ? (r.stagedReviewUrl ?? r.reviewUrl) : undefined;
  const open = showReview(r);
  const status = reviewStatus(r);
  return prShapedCard({
    key: r.key,
    title: r.title,
    titleAttr: r.title,
    status: [
      StatusChip(status.word, status.tone),
      r.needsYou && StatusChip('needs you', 'bad'),
      r.mutedAt && StatusChip('muted', 'dim'),
      posted(r),
    ],
    tone: reviewTone(r),
    repo: r.repo,
    number: r.number,
    at: r.requestedAt,
    trap: dispatchTrap([r.dispatch]),
    person: reviewPerson(r),
    actions: [
      html`<${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} split />`,
      html`<${CardLink} href=${draft ?? r.reviewUrl} label=${draft ? 'Open draft' : 'Open'} onOpen=${() => void reviewRequest('review-seen', { key: r.key })} />`,
    ],
    quiet: !OPEN.has(r.state),
    cls: 'rv-card' + (r.seenAt ? ' seen' : ''),
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
    html`<div class="sec">actions</div><div class="rv-modal-actions"><${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : effective?.mode !== 'notify'} publish=${r.publish ?? effective?.publish ?? false} /></div>`,
  ];
}

/** The mode names shown beside read-only review settings. */
const REVIEW_MODE_LABELS: Record<NonNullable<GlassSnapshot['reviewSetup']>['mode'], string> = {
  notify: 'Notify',
  'on-demand': 'On-demand',
  'auto-draft': 'Auto draft',
  'auto-review': 'Auto review',
};

/** Review rounds and the current repo's settings; all settings are read-only. */
export function Reviews({ inp, setup, repo = '' }: { inp: SectionInputs['reviews']; setup?: GlassSnapshot['reviewSetup']; repo?: string }) {
  const effective = (repo && setup?.perRepo?.[repo]) || setup;
  const canDraft = effective?.mode !== 'notify';
  const publish = effective?.publish ?? false;
  return [
    setup?.enabled
      ? html`<div class="rv-controls"><span>Review mode · ${repo || 'default'}: ${REVIEW_MODE_LABELS[effective?.mode ?? 'notify']}</span><span>Publish: ${publish ? 'on' : 'off'}</span><span class="dim">${setup.identity ?? 'GitHub identity'} · pick ${setup.running ? 'running' : 'not running'} · read-only</span></div>`
      : html`<div class="empty">Enable review notifications: <code>lobstah setup reviews</code></div>`,
    !inp.list.length
      ? html`<div class="empty">no review requests</div>`
      : inp.view === 'cards'
        ? html`<div class="cards">${inp.list.map((r) => card(r, canDraft, publish))}</div>`
        : Table(
            ['PR', 'title', 'author', 'asked by', 'asked', 'state', ''],
            inp.list.map((r) => row(r, canDraft, publish)),
            'no review requests match',
          ),
  ];
}
