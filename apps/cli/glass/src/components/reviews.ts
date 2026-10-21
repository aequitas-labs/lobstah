import { useState } from 'preact/hooks';
import type { GlassReview, GlassSnapshot } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { reviewRequest } from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html } from '../html.js';
import { Age, Table, ageText } from './common.js';

/**
 * The Reviews tab: one row or card per PR that asked for your review,
 * the ones waiting on him first. A row opens the PR in its review tool
 * ([repos.<key>].reviewTool), where the drafted review waits as the identity's pending
 * review, to edit and send. Drafting here is on demand; it never submits a review.
 */

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
const TONE: Record<string, string> = { drafted: 'ok', stale: 'warn', failed: 'bad', posted: 'dim', dismissed: 'dim', withdrawn: 'dim' };

/** The state as a person reads it: a staged draft is waiting in the review tool. */
export const reviewState = (r: Pick<GlassReview, 'state' | 'staged'>): string => r.state;

export const openReview = (r: Pick<GlassReview, 'reviewUrl'>) => () => {
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

function Actions({ r, canDraft }: { r: GlassReview; canDraft: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    setError(await reviewRequest(kind, { key: r.key }));
    setBusy(false);
  };
  return html`<span class="rv-actions">
    ${canDraft && ['requested', 'stale', 'failed'].includes(r.state) && html`<button class="btn" disabled=${busy} title="Draft this round on demand; respects the daily limit and never submits a review" onClick=${act('review-draft')}>Draft review</button>`}
    ${OPEN.has(r.state) && html`<button class="btn" disabled=${busy} title="Dismiss this round and remove it from attention; delete its staged pending draft, if any. Does not decline the review on GitHub." onClick=${act('review-dismiss')}>Dismiss</button>`}
    ${error && html`<span class="bad" role="alert">${error}</span>`}
  </span>`;
}

const badge = (r: GlassReview) => html`<span class=${'badge ' + (TONE[r.state] ?? '')}>${reviewState(r)}</span>`;

const asker = (r: GlassReview) => html`<span class="rv-person" title=${r.asker ?? r.requestedBy ?? r.author}>
  ${r.askerAvatarUrl && html`<img src=${r.askerAvatarUrl} alt="" width="24" height="24" loading="lazy" referrerpolicy="no-referrer" />`}
  <span>${r.askerName ?? r.asker ?? r.requestedBy ?? r.author}</span>
  ${r.automatic && html`<span class="badge dim" title="A workflow requested this review; showing the PR author">automatic</span>`}
</span>`;

const staged = (r: GlassReview) =>
  r.staged &&
  html`<a class="rv-staged" href=${r.stagedReviewUrl ?? r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>Open pending review</a>`;

function row(r: GlassReview, canDraft: boolean) {
  return html`<tr key=${r.key} class=${'rowhead' + (OPEN.has(r.state) ? '' : ' acked')} onClick=${openReview(r)}>
    <td><a href=${r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>${r.repo}#${r.number}</a></td>
    <td class="grow">${r.title}</td>
    <td>${r.author}</td>
    <td>${asker(r)}</td>
    <td>${Age(r.requestedAt)}</td>
    <td>${badge(r)} ${staged(r)}</td>
    <td><${Actions} r=${r} canDraft=${canDraft} /></td>
  </tr>`;
}

function card(r: GlassReview, canDraft: boolean) {
  const meta = reviewMeta(r);
  return html`<div key=${r.key} class=${'card rv-card' + (OPEN.has(r.state) ? '' : ' acked')} role="link" tabindex="0" onKeyDown=${(
    e: KeyboardEvent,
  ) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) openReview(r)();
  }} onClick=${openReview(r)}><div class="top"><b title=${r.title}>${r.title}</b>${badge(r)}</div><div class="rv-asker">${asker(r)}</div><div class="meta" title=${meta.text}>${r.repo}#${r.number} · ${Age(r.requestedAt)} ago</div>${r.reason && html`<div class="rv-reason">${r.reason}</div>`}<div class="foot">${staged(r)}<span class="footact"><${Actions} r=${r} canDraft=${canDraft} /></span></div></div>`;
}

export function Reviews({ inp, setup }: { inp: SectionInputs['reviews']; setup?: GlassSnapshot['reviewSetup'] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const canDraft = setup?.mode !== 'notify';
  const mode = async (e: Event) => {
    setBusy(true);
    setError(await reviewRequest('review-mode', { mode: (e.currentTarget as HTMLSelectElement).value }));
    setBusy(false);
  };
  return [
    setup?.enabled
      ? html`<div class="rv-controls"><label>Review mode <select aria-label="Review mode" value=${setup.mode} disabled=${busy} onChange=${mode}><option value="notify">Notify</option><option value="on-demand">On-demand</option><option value="auto">Auto draft</option></select></label><span class="dim">${setup.identity ?? 'GitHub identity'} · pick ${setup.running ? 'running' : 'not running'}</span>${error && html`<span class="bad" role="alert">${error}</span>`}</div>`
      : html`<div class="empty">Enable review notifications: <code>lobstah setup reviews</code></div>`,
    !inp.list.length
      ? html`<div class="empty">no review requests</div>`
      : inp.view === 'cards'
        ? html`<div class="cards">${inp.list.map((r) => card(r, canDraft))}</div>`
        : Table(
            ['PR', 'title', 'author', 'asked by', 'asked', 'state', ''],
            inp.list.map((r) => row(r, canDraft)),
            'no review requests match',
          ),
  ];
}
