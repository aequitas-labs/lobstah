import { useState } from 'preact/hooks';
import type { GlassReview, GlassSnapshot } from '@lobstah/core';
import type { SectionInputs } from '../../src/glass-diff.js';
import { dismissReview, reviewRequest, showModal } from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html } from '../html.js';
import { Age, Table, ageText } from './common.js';
import { can } from '../backend.js';
import { getState } from '../store.js';
import { Avatar, CardLink, githubAvatarUrl } from './card.js';
import type { CardPerson, CardTone } from './card.js';
import { StatusChip, dispatchTrap, prShapedCard } from './prs.js';

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
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string>();
  if (!DISMISSABLE.includes(r.state)) return null;
  const dismiss = async (e: Event) => {
    e.stopPropagation();
    setState('busy');
    const refusal = await dismissReview(r.key);
    setError(refusal);
    setState(refusal ? 'idle' : 'sent');
  };
  if (state === 'sent') return html`<span class="ok" role="status">Sent to the boat that drafted it</span>`;
  return html`<button class="btn" disabled=${state === 'busy'} onClick=${dismiss}>Dismiss</button>${error && html` <span class="bad" role="alert">${error}</span>`}`;
}

/** Sending a drafted review: the request, the button, and what a card's second tap says it posts. */
const SEND = {
  approve: { kind: 'review-approve', label: 'Approve', posts: 'approval' },
  request_changes: { kind: 'review-request-changes', label: 'Request changes', posts: 'changes request' },
  comment: { kind: 'review-comment', label: 'Publish comment', posts: 'comment' },
} as const satisfies Record<string, { kind: ReviewRequestKind; label: string; posts: string }>;

/**
 * The review's actions. On a card (`confirm`), sending the review takes a
 * second tap that names what it posts, as Merge when green does; the modal
 * sends on the first, from beside the findings.
 */
function Actions({ r, canDraft, publish, confirm = false }: { r: GlassReview; canDraft: boolean; publish: boolean; confirm?: boolean }) {
  // A source without review actions may still dismiss; the hooks below run only with them.
  if (!can('review-request')) return can('review-dismiss') ? html`<${Dismiss} r=${r} />` : null;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    setAsking(false);
    setError(await reviewRequest(kind, { key: r.key }));
    setBusy(false);
  };
  const send = SEND[r.verdict ?? 'comment'];
  const sendButton =
    r.state === 'drafted' &&
    (confirm && asking
      ? html`<button class="btn go" disabled=${busy} onClick=${act(send.kind)}>Post ${send.posts} on #${r.number}</button><button class="btn" onClick=${(
          e: Event,
        ) => {
          e.stopPropagation();
          setAsking(false);
        }}>Keep</button>`
      : html`<button class="btn" disabled=${busy} onClick=${
          confirm
            ? (e: Event) => {
                e.stopPropagation();
                setAsking(true);
              }
            : act(send.kind)
        }>${send.label}</button>`);
  return html`<span class=${asking ? 'rv-actions asking' : 'rv-actions'}>
    ${((canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale') && html`<button class="btn" disabled=${busy} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'} onClick=${act('review-draft')}>${r.state === 'stale' ? 'Redraft' : publish ? 'Review (publish)' : 'Review (draft)'}</button>`}
    ${sendButton}
    ${(OPEN.has(r.state) || r.notification) && html`<button class="btn" disabled=${busy} title="Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub." onClick=${act('review-skip')}>Skip</button>`}
    ${error && html`<span class="bad" role="alert">${error}</span>`}
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
    <td>${badge(r)} ${staged(r)}</td>
    <td><${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} /></td>
  </tr>`;
}

/** A posted review's verdict, as its card's status. */
const POSTED: Record<string, string> = { approve: 'approved', request_changes: 'changes requested' };

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
 * then repo · age · #number · 🪤 the trap drafting it; then its actions
 * (draft, send, skip, or dismiss on a wharf), then Open draft (↗ Open before
 * there is one) at the bar's right. Who asked, the findings and the reason are in its modal.
 */
function card(r: GlassReview, canDraft: boolean, publish: boolean) {
  const draft = r.staged ? (r.stagedReviewUrl ?? r.reviewUrl) : undefined;
  const open = showReview(r);
  const status = reviewStatus(r);
  return prShapedCard({
    key: r.key,
    title: r.title,
    titleAttr: r.title,
    status: [StatusChip(status.word, status.tone), r.needsYou && StatusChip('needs you', 'bad')],
    tone: reviewTone(r),
    repo: r.repo,
    number: r.number,
    at: r.requestedAt,
    trap: dispatchTrap([r.dispatch]),
    person: reviewPerson(r),
    actions: [
      html`<${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} confirm />`,
      html`<${CardLink} href=${draft ?? r.reviewUrl} label=${draft ? 'Open draft' : '↗ Open'} onOpen=${() => void reviewRequest('review-seen', { key: r.key })} />`,
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
