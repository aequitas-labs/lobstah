import { useState } from 'preact/hooks';
import type { GlassReview, ReviewComment } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { reviewRequest } from '../actions.js';
import type { ReviewRequestKind } from '../actions.js';
import { html } from '../html.js';
import { Age } from './common.js';
import { MarkdownElements } from './markdown.js';

/**
 * The Reviews tab: one row per PR that asked for Chris's review, the ones
 * that ask for him first. A row opens to the draft (its summary and inline
 * comments) with Post, Edit, Dismiss, and, for a stale or failed round,
 * Re-draft. Post is always a comment-only review; nothing here approves or
 * requests changes.
 */

const OPEN = new Set(['requested', 'drafting', 'drafted', 'stale', 'failed']);
const TONE: Record<string, string> = { drafted: 'ok', stale: 'warn', failed: 'bad', posted: 'dim', dismissed: 'dim', withdrawn: 'dim' };

/** Draft markdown names no files: an image reference shows its alt text. */
const noImage = (_name: string, alt: string) => alt;

function Comments({ list }: { list: ReviewComment[] }) {
  if (!list.length) return html`<div class="dim">no inline comments</div>`;
  return html`<ul class="rv-comments">${list.map(
    (c, i) =>
      html`<li key=${i}><code>${c.path}:${c.line}${c.side === 'LEFT' ? ' (old)' : ''}</code><div class="mdpage"><${MarkdownElements} text=${c.body} image=${noImage} /></div></li>`,
  )}</ul>`;
}

function Editor({ r, onDone }: { r: GlassReview; onDone: (error?: string) => void }) {
  const [body, setBody] = useState(r.body ?? '');
  const [comments, setComments] = useState<ReviewComment[]>(r.comments ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const error = await reviewRequest('review-edit', { key: r.key, body, comments });
    setBusy(false);
    onDone(error);
  };
  return html`<div class="rv-edit">
    <label>Summary<textarea rows="8" value=${body} onInput=${(e: Event) => setBody((e.currentTarget as HTMLTextAreaElement).value)} /></label>
    ${comments.map(
      (c, i) => html`<div key=${c.path + ':' + c.line + ':' + i} class="rv-edit-comment">
        <code>${c.path}:${c.line}</code>
        <textarea rows="3" value=${c.body} onInput=${(e: Event) => setComments(comments.map((x, j) => (j === i ? { ...x, body: (e.currentTarget as HTMLTextAreaElement).value } : x)))} />
        <button class="btn" title="remove this comment" onClick=${() => setComments(comments.filter((_, j) => j !== i))}>remove</button>
      </div>`,
    )}
    <div class="rv-actions"><button class="btn" disabled=${busy} onClick=${save}>Save</button><button class="btn" disabled=${busy} onClick=${() => onDone()}>Cancel</button></div>
  </div>`;
}

function Detail({ r }: { r: GlassReview }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act =
    (kind: ReviewRequestKind, extra: Record<string, unknown> = {}) =>
    async () => {
      setBusy(true);
      setError(await reviewRequest(kind, { key: r.key, ...extra }));
      setBusy(false);
    };
  if (editing) return html`<${Editor} r=${r} onDone=${(e?: string) => (setError(e), setEditing(false))} />`;
  const hasDraft = r.state === 'drafted' || r.state === 'stale';
  return html`<div class="rv-detail">
    ${r.reason && html`<div class="dim">${r.reason}</div>`}
    ${r.state === 'stale' && html`<div class="warn">The draft reviews ${r.headSha.slice(0, 7)}; the PR is now at ${r.prHeadSha.slice(0, 7)}.</div>`}
    ${hasDraft && r.body !== undefined && html`<div class="mdpage"><${MarkdownElements} text=${r.body} image=${noImage} /></div>`}
    ${hasDraft && html`<${Comments} list=${r.comments ?? []} />`}
    ${r.state === 'posted' && html`<div class="dim">posted ${r.by ? `by ${r.by} ` : ''}${Age(r.postedAt)} ago</div>`}
    <div class="rv-actions">
      ${r.state === 'drafted' && html`<button class="btn" disabled=${busy} title="post as a comment-only review" onClick=${act('review-post')}>Post</button>`}
      ${r.state === 'stale' && html`<button class="btn" disabled=${busy} title="post the older draft as a comment-only review" onClick=${act('review-post', { stale: true })}>Post anyway</button>`}
      ${(r.state === 'stale' || r.state === 'failed') && html`<button class="btn" disabled=${busy} onClick=${act('review-redraft')}>Re-draft</button>`}
      ${hasDraft && html`<button class="btn" disabled=${busy} onClick=${() => setEditing(true)}>Edit</button>`}
      ${OPEN.has(r.state) && html`<button class="btn" disabled=${busy} onClick=${act('review-dismiss')}>Dismiss</button>`}
      <a class="btn" href=${r.url} target="_blank" rel="noopener">open PR</a>
    </div>
    ${error && html`<div class="bad" role="alert">${error}</div>`}
  </div>`;
}

function Row({ r }: { r: GlassReview }) {
  const [open, setOpen] = useState(false);
  return [
    html`<tr key=${r.key} class=${'rowhead' + (r.stands ? '' : ' acked')} onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <td>${r.repo}#${r.number}</td>
      <td class="grow">${r.title}</td>
      <td>${r.author}</td>
      <td>${r.requestedBy ?? ''}</td>
      <td>${Age(r.requestedAt)}</td>
      <td><span class=${'badge ' + (TONE[r.state] ?? '')}>${r.state}</span></td>
    </tr>`,
    open && html`<tr key=${r.key + ':detail'} class="rv-row"><td colspan="6"><${Detail} r=${r} /></td></tr>`,
  ];
}

export function Reviews({ inp }: { inp: SectionInputs['reviews'] }) {
  if (!inp.list.length) return html`<div class="empty">no review requests — turn them on with [reviews].enabled</div>`;
  return html`<div class="wrap"><table><tbody><tr><th>PR</th><th>title</th><th>author</th><th>asked by</th><th>asked</th><th>state</th></tr>${inp.list.map(
    (r) => html`<${Row} key=${r.key} r=${r} />`,
  )}</tbody></table></div>`;
}
