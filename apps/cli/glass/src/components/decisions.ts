import type { Attachment } from '@lobstah/core';
import { decisionFileUrl } from '../../../src/glass-diff.js';
import type { DecisionCard } from '../../../src/glass-diff.js';
import { addFiles, removeFile, sendAnswer, setDraft, toggleOption } from '../actions.js';
import { html } from '../html.js';
import type { DecisionDraft } from '../store.js';
import { Age, NamedText, opener } from './common.js';
import { Markdown } from './report.js';

/**
 * The deck's decisions: one full-row card per decision the helm framed
 * (`man ask`), newest first, and a plain card per raw question it has not.
 * A card takes an answer in place: an option, text, files, or any mix, sent
 * with one POST. The server stores it and the helm acts on it.
 */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** Grow a text box with its content. */
const grow = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
};

function attachments(key: string, list: Attachment[]) {
  if (!list.length) return null;
  return html`<div class="dfiles">${list.map((a) =>
    IMAGE.test(a.name)
      ? html`<a key=${a.name} class="dimg" href=${decisionFileUrl(key, a.name)} target="_blank" rel="noopener"><img src=${decisionFileUrl(key, a.name)} alt=${a.name} loading="lazy" /></a>`
      : html`<div key=${a.name} class="dfile"><span>${a.name}</span> <span class="dim">· ${a.type} · ${a.bytes} bytes · </span><code>${a.path}</code></div>`,
  )}</div>`;
}

function answerForm(c: DecisionCard, draft: DecisionDraft | undefined, accept: string) {
  const key = c.key;
  const options = c.kind === 'decision' ? c.options : [];
  const text = draft?.text ?? '';
  const files = draft?.files ?? [];
  const sending = !!draft?.sending;
  return [
    options.length > 0 &&
      html`<div class="doptions">${options.map(
        (o) =>
          html`<button key=${o} type="button" class=${'btn dopt' + (draft?.option === o ? ' on' : '')} aria-pressed=${draft?.option === o ? 'true' : 'false'} disabled=${sending} onClick=${() => toggleOption(key, o)}>${o}</button>`,
      )}</div>`,
    html`<textarea
      class="danswer"
      rows="2"
      placeholder=${options.length ? 'Add to your answer, or answer in your own words' : 'Your answer'}
      value=${text}
      disabled=${sending}
      onInput=${(e: Event) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        grow(el);
        setDraft(key, { text: el.value, error: undefined });
      }}
    ></textarea>`,
    html`<div class="dfoot">
      <label class="btn dattach" title="attach images or files">attach<input type="file" multiple accept=${accept} disabled=${sending} onChange=${(
        e: Event,
      ) => {
        const input = e.currentTarget as HTMLInputElement;
        void addFiles(key, input.files).then(() => {
          input.value = '';
        });
      }} /></label>
      ${files.map(
        (f, i) =>
          html`<span key=${f.name + i} class="dchip">${f.name}<button type="button" class="dx" title="remove" disabled=${sending} onClick=${() => removeFile(key, i)}>×</button></span>`,
      )}
      ${draft?.error && html`<span class="bad derr">${draft.error}</span>`}
      <button type="button" class="btn dsend" disabled=${sending} onClick=${() => void sendAnswer(key)}>${sending ? 'Sending…' : 'Send'}</button>
    </div>`,
  ];
}

function card(c: DecisionCard, draft: DecisionDraft | undefined, focused: boolean, accept: string) {
  const dispatch = c.dispatch;
  const lane = c.lane ?? 'work';
  const meta = [
    dispatch &&
      html`<a class="dlink" href="#" onClick=${(e: Event) => {
        e.preventDefault();
        opener('dispatch', lane + ':' + dispatch)();
      }}>${dispatch.slice(0, 8)}</a>`,
    c.repo,
    [Age(c.at), ' ago'],
  ].filter(Boolean);
  const metaLine = meta.flatMap((m, i) => (i ? [' · ', m] : [m]));
  const cls = 'dcard' + (c.kind === 'question' ? ' plain' : '') + (draft?.sent ? ' answered' : '') + (focused ? ' focus' : '');
  return html`<div key=${c.key} class=${cls} data-decision=${c.key}>
    <div class="dtop">
      ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
      <b class="dtitle">${c.kind === 'decision' ? c.title : NamedText(c.note)}</b>
      <span class="dmeta dim">${metaLine}</span>
    </div>
    ${c.kind === 'decision' && c.detail.trim() && html`<${Markdown} text=${c.detail} fileUrl=${(name: string) => decisionFileUrl(c.key, name)} />`}
    ${c.kind === 'decision' && attachments(c.key, c.attachments)}
    ${draft?.sent ? html`<div class="danswered ok">answered · ${draft.sent}</div>` : answerForm(c, draft, accept)}
  </div>`;
}

export function DeckDecisions({
  cards,
  drafts,
  focus,
  extensions,
}: {
  cards: DecisionCard[];
  drafts: Record<string, DecisionDraft>;
  focus: string | null;
  extensions: string[];
}) {
  const accept = extensions.join(',');
  const body = cards.length
    ? html`<div class="dcards">${cards.map((c) => card(c, drafts[c.key], c.key === focus, accept))}</div>`
    : html`<div class="empty">none</div>`;
  return html`<section class="decisions"><h2>decisions</h2>${body}</section>`;
}
