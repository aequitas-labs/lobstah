import type { Attachment } from '@lobstah/core';
import { useEffect, useRef } from 'preact/hooks';
import { decisionFileUrl } from '../../../src/glass-diff.js';
import type { DecisionCard } from '../../../src/glass-diff.js';
import {
  addFiles,
  HOTKEY_MAX,
  closeDecision,
  dismissAlert,
  markViewed,
  openDecision,
  pasteImages,
  removeFile,
  sendAnswer,
  setDraft,
  stepDecision,
  toggleOption,
} from '../actions.js';
import { html } from '../html.js';
import type { DecisionDraft } from '../store.js';
import { Age, ImageThumb, NamedText, opener } from './common.js';
import { Markdown } from './report.js';

/**
 * Decisions: the deck lists every open decision the helm framed (`man ask`)
 * and every raw question it has not, newest first, as compact rows: title,
 * source, age, and state (unread, read, answered). A row opens the decision
 * modal, which shows the whole decision and takes the answer (an option,
 * text, files, or any mix, sent with one POST), then loads the next open
 * one. The modal steps through open decisions oldest first. Showing a
 * decision there records its first view on the server; viewing never
 * answers. A new-decision alert counts the unread ones on every tab.
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
      ? html`<span key=${a.name}>${ImageThumb(decisionFileUrl(key, a.name), a.name, 'dimg')}</span>`
      : html`<div key=${a.name} class="dfile"><span>${a.name}</span> <span class="dim">· ${a.type} · ${a.bytes} bytes · </span><code>${a.path}</code></div>`,
  )}</div>`;
}

function answerForm(c: DecisionCard, draft: DecisionDraft | undefined, accept: string) {
  const key = c.key;
  const options = c.kind === 'decision' ? c.options : [];
  const text = draft?.text ?? '';
  const files = draft?.files ?? [];
  const sending = !!draft?.sending;
  // 1..N choose an option, N+1 the text field; only 1–9 are keys.
  const hotkey = (i: number) => (i + 1 <= HOTKEY_MAX ? String(i + 1) : undefined);
  const textKey = hotkey(options.length);
  return [
    options.length > 0 &&
      html`<div class="doptions">${options.map((o, i) => {
        const k = hotkey(i);
        return html`<button key=${o} type="button" class=${'btn dopt' + (draft?.option === o ? ' on' : '')} aria-pressed=${draft?.option === o ? 'true' : 'false'} aria-keyshortcuts=${k} disabled=${sending} onClick=${() => toggleOption(key, o)}>${k && html`<kbd class="dkey" aria-hidden="true">${k}</kbd>`}<span class="dlabel">${o}</span></button>`;
      })}</div>`,
    html`<div class="danswer-wrap">${textKey && html`<kbd class="dkey dkey-text" aria-hidden="true">${textKey}</kbd>`}<textarea
      class="danswer"
      rows="2"
      aria-keyshortcuts=${textKey}
      aria-label=${options.length ? 'Your answer, in your own words' : 'Your answer'}
      placeholder=${options.length ? 'Add to your answer, or answer in your own words' : 'Your answer'}
      value=${text}
      disabled=${sending}
      onInput=${(e: Event) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        grow(el);
        setDraft(key, { text: el.value, error: undefined });
      }}
      onPaste=${(e: ClipboardEvent) => void pasteImages(key, e)}
    ></textarea></div>`,
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

/** A decision's title: the helm's, or the worker's note for a raw question. */
const titleOf = (c: DecisionCard) => (c.kind === 'decision' ? c.title : NamedText(c.note));

/** Unread, read, or answered (from this page, until the snapshot drops it). */
function stateOf(c: DecisionCard, draft: DecisionDraft | undefined, viewedHere: boolean): 'unread' | 'read' | 'answered' {
  if (draft?.sent) return 'answered';
  return c.viewedAt || viewedHere ? 'read' : 'unread';
}

/** Where a decision came from: its dispatch (a link to it) and repo. */
function source(c: DecisionCard) {
  const dispatch = c.dispatch;
  const lane = c.lane ?? 'work';
  const parts = [
    dispatch &&
      html`<a class="dlink" href="#" onClick=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        opener('dispatch', lane + ':' + dispatch)();
      }}>${dispatch.slice(0, 8)}</a>`,
    c.repo,
  ].filter(Boolean);
  return parts.flatMap((m, i) => (i ? [' · ', m] : [m]));
}

function row(c: DecisionCard, draft: DecisionDraft | undefined, viewedHere: boolean, focused: boolean) {
  const state = stateOf(c, draft, viewedHere);
  const open = () => openDecision(c.key);
  return html`<li key=${c.key} class=${'drow ' + state + (focused ? ' focus' : '')} data-decision=${c.key}>
    <button type="button" class="dopen" onClick=${open} aria-label=${`${state}: ${c.kind === 'decision' ? c.title : c.note}`}>
      ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
      <b class="dtitle">${titleOf(c)}</b>
    </button>
    <span class="dmeta dim">${source(c)}</span>
    <span class="dage dim">${Age(c.at)} ago</span>
    <span class=${'dstate ' + state}>${state === 'answered' ? `answered · ${draft!.sent}` : state}</span>
  </li>`;
}

export function DeckDecisions({
  cards,
  drafts,
  focus,
  viewedHere,
  unread,
}: {
  cards: DecisionCard[];
  drafts: Record<string, DecisionDraft>;
  focus: string | null;
  viewedHere: Record<string, true>;
  unread: number;
}) {
  const body = cards.length
    ? html`<ul class="dlist">${cards.map((c) => row(c, drafts[c.key], !!viewedHere[c.key], c.key === focus))}</ul>`
    : html`<div class="empty">none</div>`;
  return html`<section class="decisions"><h2>decisions${unread > 0 && html`<span class="dbadge" aria-label=${`${unread} new`}>${unread}</span>`}</h2>${body}</section>`;
}

/** The modal's key legend: what each key does here. */
function legend(options: number) {
  const pick = Math.min(options, HOTKEY_MAX);
  const text = options + 1 <= HOTKEY_MAX ? String(options + 1) : undefined;
  const parts = [
    pick > 0 && [html`<kbd>1</kbd>`, pick > 1 && ['–', html`<kbd>${pick}</kbd>`], ' choose'],
    text && [html`<kbd>${text}</kbd>`, ' write'],
    pick > 0 && [html`<kbd>Enter</kbd>`, ' on a chosen option sends'],
    [html`<kbd>←</kbd>`, ' ', html`<kbd>→</kbd>`, ' previous / next'],
    [html`<kbd>Esc</kbd>`, ' leaves the text box, then closes'],
    [html`<kbd>d</kbd>`, ' opens decisions anywhere'],
  ].filter(Boolean);
  return html`<div class="dlegend dim">${parts.flatMap((p, i) => (i ? [' · ', p] : [p]))}</div>`;
}

/** Elements a Tab press may land on inside the modal. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The decision modal: one decision in full, with the answer form, and
 * previous / next over the open decisions (oldest first) with its position.
 * It holds focus while open and gives it back on close. `key: null` is the
 * "all decisions answered" state: the next click or Escape closes it.
 */
export function DecisionModal({
  open,
  order,
  drafts,
  extensions,
}: {
  open: { key: string | null } | null;
  order: DecisionCard[];
  drafts: Record<string, DecisionDraft>;
  extensions: string[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    returnTo.current = document.activeElement;
    box.current?.focus();
    return () => {
      const back = returnTo.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [isOpen]);
  const key = open?.key ?? null;
  useEffect(() => {
    if (key) void markViewed(key);
  }, [key]);
  if (!open) return null;
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return void e.preventDefault();
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const c = key ? order.find((x) => x.key === key) : undefined;
  const i = c ? order.indexOf(c) : -1;
  const shell = (label: string, body: unknown, shown = '') =>
    html`<div id="doverlay" class="open" onClick=${(e: Event) => e.target === e.currentTarget && closeDecision()}>
      <div class="modal dmodal" role="dialog" aria-modal="true" aria-labelledby="dmodal-title" tabindex="-1" ref=${box} onKeyDown=${trap} data-decision=${shown}>
        <button type="button" class="x" aria-label="close" aria-keyshortcuts="Escape" onClick=${closeDecision}>×</button>
        <h3 id="dmodal-title" class="sr-only">${label}</h3>
        ${body}
      </div>
    </div>`;
  if (!c) {
    return shell(
      'All decisions answered',
      html`<div class="ddone" onClick=${closeDecision}><div class="ok">✓ All decisions answered.</div><div class="dim">Click anywhere or press Escape to close.</div></div>`,
    );
  }
  const draft = drafts[c.key];
  return shell(
    c.kind === 'decision' ? c.title : c.note,
    html`<div class="dnav">
        <button type="button" class="btn dprev" aria-label="previous decision" aria-keyshortcuts="ArrowLeft" disabled=${i <= 0} onClick=${() => stepDecision(-1)}>‹ prev</button>
        <span class="dpos" aria-live="polite">${i + 1} of ${order.length}</span>
        <button type="button" class="btn dnext" aria-label="next decision" aria-keyshortcuts="ArrowRight" disabled=${i >= order.length - 1} onClick=${() => stepDecision(1)}>next ›</button>
      </div>
      <div class="dtop">
        ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
        <b class="dtitle">${titleOf(c)}</b>
        <span class="dmeta dim">${source(c)}${source(c).length ? ' · ' : ''}${Age(c.at)} ago</span>
      </div>
      ${c.kind === 'decision' && c.detail.trim() && html`<${Markdown} text=${c.detail} fileUrl=${(name: string) => decisionFileUrl(c.key, name)} />`}
      ${c.kind === 'decision' && attachments(c.key, c.attachments)}
      ${draft?.sent ? html`<div class="danswered ok">answered · ${draft.sent}</div>` : answerForm(c, draft, extensions.join(','))}
      ${legend(c.kind === 'decision' ? c.options.length : 0)}`,
    c.key,
  );
}

/**
 * The new-decision alert, on every tab: a count of unread decisions, polite
 * to screen readers, never taking focus or closing another modal. Its layer
 * (`--layer-alert`) sits below every modal and backdrop, so an open modal
 * covers it and it shows again when the modal closes. A click opens the
 * decision modal at the oldest unread one; × dismisses it until another
 * decision arrives, and marks nothing read.
 */
export function DecisionAlert({ unread, dismissed }: { unread: DecisionCard[]; dismissed: string[] }) {
  const fresh = unread.some((c) => !dismissed.includes(c.key));
  const show = unread.length > 0 && fresh;
  const n = unread.length;
  const words = `${n} new decision${n === 1 ? '' : 's'}`;
  return html`<div class="dalert-live" role="status" aria-live="polite">${
    show &&
    html`<div class="dalert">
      <button type="button" class="dalert-open" aria-keyshortcuts="d" onClick=${() => openDecision()}><span class="dcount" aria-hidden="true">${n}</span> <span>${words}</span></button>
      <button type="button" class="dx" aria-label="dismiss" title="dismiss" onClick=${dismissAlert}>×</button>
    </div>`
  }</div>`;
}
