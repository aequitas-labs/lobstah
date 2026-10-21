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
 * review, to edit and send. On-demand jobs follow the repo’s draft/publish setting.
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

function Actions({ r, canDraft, publish }: { r: GlassReview; canDraft: boolean; publish: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    setError(await reviewRequest(kind, { key: r.key }));
    setBusy(false);
  };
  return html`<span class="rv-actions">
    ${((canDraft && ['requested', 'failed'].includes(r.state)) || r.state === 'stale') && html`<button class="btn" disabled=${busy} title=${publish ? 'Review this round and publish by verdict if fresh; approve needs your click; respects the daily limit' : 'Draft this round as your pending review; respects the daily limit'} onClick=${act('review-draft')}>${r.state === 'stale' ? 'Redraft' : publish ? 'Review (publish)' : 'Review (draft)'}</button>`}
    ${r.state === 'drafted' && html`<button class="btn" disabled=${busy} onClick=${act(r.verdict === 'approve' ? 'review-approve' : r.verdict === 'request_changes' ? 'review-request-changes' : 'review-comment')}>${r.verdict === 'approve' ? 'Approve' : r.verdict === 'request_changes' ? 'Request changes' : 'Publish comment'}</button>`}
    ${(OPEN.has(r.state) || r.notification) && html`<button class="btn" disabled=${busy} title="Handle it yourself; removes lobstah's draft. Deletes its staged pending review; does not decline the review on GitHub." onClick=${act('review-skip')}>Skip</button>`}
    ${error && html`<span class="bad" role="alert">${error}</span>`}
  </span>`;
}

const badge = (r: GlassReview) =>
  html`<span class=${'badge ' + (TONE[r.state] ?? '')}>${reviewState(r)}</span>${r.verdict && html`<span class="badge">${r.verdict.replace('_', ' ')}</span>`}${r.needsYou && html`<span class="badge warn">needs you</span>`}`;
const findings = (r: GlassReview) =>
  html`${r.summary && html`<details onClick=${(e: Event) => e.stopPropagation()}><summary>Summary</summary><div class="rv-reason">${r.summary}</div></details>`}${r.blocking?.map((b) => html`<div class="rv-reason bad">${b.path}:${b.line} · ${b.body}</div>`)}`;

const asker = (r: GlassReview) => html`<span class="rv-person" title=${r.asker ?? r.requestedBy ?? r.author}>
  ${r.askerAvatarUrl && html`<img src=${r.askerAvatarUrl} alt="" width="24" height="24" loading="lazy" referrerpolicy="no-referrer" />`}
  <span>${r.askerName ?? r.asker ?? r.requestedBy ?? r.author}</span>
  ${r.automatic && html`<span class="badge dim" title="A workflow requested this review; showing the PR author">automatic</span>`}
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

function card(r: GlassReview, canDraft: boolean, publish: boolean) {
  const meta = reviewMeta(r);
  return html`<div key=${r.key} id=${'review-' + encodeURIComponent(r.key)} data-review=${r.key} class=${'card rv-card' + (r.seenAt ? ' seen' : !OPEN.has(r.state) ? ' acked' : '')} role="link" tabindex="0" onKeyDown=${(
    e: KeyboardEvent,
  ) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) openReview(r)();
  }} onClick=${openReview(r)}><div class="top"><b title=${r.title}>${r.title}</b>${badge(r)}</div><div class="rv-asker">${asker(r)}</div><div class="meta" title=${meta.text}>${r.repo}#${r.number} · ${Age(r.requestedAt)} ago</div>${findings(r)}${r.reason && html`<div class="rv-reason">${r.reason}</div>`}<div class="foot">${staged(r)}<span class="footact"><${Actions} r=${r} canDraft=${r.mode ? r.mode !== 'notify' : canDraft} publish=${r.publish ?? publish} /></span></div></div>`;
}

export function Reviews({ inp, setup, repo = '' }: { inp: SectionInputs['reviews']; setup?: GlassSnapshot['reviewSetup']; repo?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const effective = (repo && setup?.perRepo?.[repo]) || setup;
  const canDraft = effective?.mode !== 'notify';
  const publish = effective?.publish ?? false;
  const change = async (mode: string, publish: boolean) => {
    setBusy(true);
    setError(await reviewRequest('review-mode', { mode, publish, ...(repo ? { repo } : {}) }));
    setBusy(false);
  };
  return [
    setup?.enabled
      ? html`<div class="rv-controls"><label>Review mode · ${repo || 'default'} <select aria-label="Review mode" value=${effective?.mode} disabled=${busy} onChange=${(
          e: Event,
        ) => {
          const next = (e.currentTarget as HTMLSelectElement).value;
          return change(next, next.startsWith('auto-') ? next === 'auto-review' : publish);
        }}><option value="notify">Notify</option><option value="on-demand">On-demand</option><option value="auto-draft">Auto draft</option><option value="auto-review">Auto review</option></select></label><label title="Publish sends request changes for blocking findings, otherwise a comment. Approve always needs your click."><input type="checkbox" aria-label="Publish reviews" checked=${publish} disabled=${busy} onChange=${(
          e: Event,
        ) => {
          const next = (e.currentTarget as HTMLInputElement).checked;
          return change(effective?.mode.startsWith('auto-') ? (next ? 'auto-review' : 'auto-draft') : (effective?.mode ?? 'notify'), next);
        }} />Publish</label><span class="dim">${setup.identity ?? 'GitHub identity'} · pick ${setup.running ? 'running' : 'not running'}</span>${error && html`<span class="bad" role="alert">${error}</span>`}</div>`
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
