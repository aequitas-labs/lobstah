import { useState } from 'preact/hooks';
import type { GlassReview } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { reviewRequest } from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html } from '../html.js';
import { Age, Table, ageText } from './common.js';

/**
 * The Reviews tab: one row or card per PR that asked for your review,
 * the ones waiting on him first. A row opens the PR in its review tool
 * ([repos.<key>].reviewTool), where the drafted review waits as the identity's pending
 * review, to edit and send. Here a review can only be dismissed or, when
 * stale or failed, re-drafted.
 */

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
const TONE: Record<string, string> = { drafted: 'ok', stale: 'warn', failed: 'bad', posted: 'dim', dismissed: 'dim', withdrawn: 'dim' };

/** The state as a person reads it: a staged draft is waiting in the review tool. */
export const reviewState = (r: Pick<GlassReview, 'state' | 'staged'>): string =>
  r.state === 'drafted' && r.staged ? 'ready to send' : r.state;

export const openReview = (r: Pick<GlassReview, 'reviewUrl'>) => () => {
  window.open(r.reviewUrl, '_blank', 'noopener');
};

/** The meta line: who asked, when, and why the round is where it is. */
export function reviewMeta(r: GlassReview): { nodes: unknown[]; text: string } {
  const asked = r.requestedBy ? `asked by ${r.requestedBy}` : 'review requested';
  return {
    nodes: [r.repo, '#', String(r.number), ' · ', asked, ' · ', Age(r.requestedAt), ' ago', r.reason ? ` · ${r.reason}` : ''],
    text: [`${r.repo}#${r.number}`, asked, `${ageText(r.requestedAt)} ago`, r.reason ?? ''].filter(Boolean).join(' · '),
  };
}

function Actions({ r }: { r: GlassReview }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = (kind: ReviewRequestKind) => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    setError(await reviewRequest(kind, { key: r.key }));
    setBusy(false);
  };
  return html`<span class="rv-actions">
    ${(r.state === 'stale' || r.state === 'failed') && html`<button class="btn" disabled=${busy} onClick=${act('review-redraft')}>re-draft</button>`}
    ${OPEN.has(r.state) && html`<button class="btn" disabled=${busy} title="drop it; a pending draft is deleted" onClick=${act('review-dismiss')}>dismiss</button>`}
    ${error && html`<span class="bad" role="alert">${error}</span>`}
  </span>`;
}

const badge = (r: GlassReview) => html`<span class=${'badge ' + (TONE[r.state] ?? '')}>${reviewState(r)}</span>`;

function row(r: GlassReview) {
  return html`<tr key=${r.key} class=${'rowhead' + (r.stands ? '' : ' acked')} onClick=${openReview(r)}>
    <td><a href=${r.reviewUrl} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>${r.repo}#${r.number}</a></td>
    <td class="grow">${r.title}</td>
    <td>${r.author}</td>
    <td>${r.requestedBy ?? ''}</td>
    <td>${Age(r.requestedAt)}</td>
    <td>${badge(r)}</td>
    <td><${Actions} r=${r} /></td>
  </tr>`;
}

function card(r: GlassReview) {
  const meta = reviewMeta(r);
  return html`<div key=${r.key} class=${'card' + (r.stands ? '' : ' acked')} onClick=${openReview(r)}><div class="top"><b title=${r.title}>${r.title}</b>${badge(r)}</div><div class="meta" title=${meta.text}>${meta.nodes}</div><div class="foot"><span class="footact"><${Actions} r=${r} /></span></div></div>`;
}

export function Reviews({ inp }: { inp: SectionInputs['reviews'] }) {
  if (!inp.list.length) return html`<div class="empty">no review requests — turn them on with [reviews].enabled</div>`;
  if (inp.view === 'cards') return html`<div class="cards">${inp.list.map(card)}</div>`;
  return Table(['PR', 'title', 'author', 'asked by', 'asked', 'state', ''], inp.list.map(row), 'no review requests match');
}
