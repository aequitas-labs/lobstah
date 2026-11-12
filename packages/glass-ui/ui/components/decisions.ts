import { DesktopStartAction } from './common.js';
import { validDesktopStartLink } from '../../../core/src/desktop-start-link.js';
import type { Attachment } from '@lobstah/core';
import { useEffect, useRef } from 'preact/hooks';
import { decisionNeighbours } from '../../src/glass-diff.js';
import type { DecisionCard } from '../../src/glass-diff.js';
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
import { getState } from '../store.js';
import { Age, ImageThumb, NamedText, RepoName, opener } from './common.js';
import { Markdown } from './report.js';
import { LinkedText } from './links.js';
import { PermissionsProposalCard } from './permissions-proposal.js';
import { RunCardBody } from './run-card.js';
import { RUN_DECLINE, RunStatusIcon, runStatus } from './run-status.js';
import { can, fileUrl } from '../backend.js';
import { SendHint, onSendKey, sendShortcut, touchOnly } from '../send-key.js';

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

/** Grow a text box with its content; empty, it returns to its CSS height, which fits the placeholder. */
const grow = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto';
  // scrollHeight leaves out the border, which a border-box height includes.
  el.style.height = el.value ? el.scrollHeight + el.offsetHeight - el.clientHeight + 'px' : '';
};

function attachments(key: string, list: Attachment[]) {
  if (!list.length) return null;
  return html`<div class="dfiles">${list.map((a) =>
    IMAGE.test(a.name)
      ? html`<span key=${a.name}>${ImageThumb(fileUrl({ kind: 'decision', key }, a.name), a.name, 'dimg')}</span>`
      : html`<div key=${a.name} class="dfile"><span>${a.name}</span> <span class="dim">· ${a.type} · ${a.bytes} bytes · </span><code>${a.path}</code></div>`,
  )}</div>`;
}

function answerForm(c: DecisionCard, draft: DecisionDraft | undefined, accept: string) {
  const key = c.key;
  // A permission card takes only an explicit option; a text reply can't grant anything.
  const permission = c.kind === 'decision' && c.permission;
  // A run card's options (Decline) send at once, like a permission card's; it also takes a reply. Run is its own button.
  const instant = permission || (c.kind === 'decision' && !!c.run);
  const options = c.kind === 'decision' ? c.options : [];
  const notes = (c.kind === 'decision' && c.optionNotes) || {};
  const text = draft?.text ?? '';
  const files = draft?.files ?? [];
  const sending = !!draft?.sending;
  // 1..N choose an option, N+1 the text field; only 1–9 are keys, and none on a touch screen.
  const touch = touchOnly();
  const hotkey = (i: number) => (!touch && i + 1 <= HOTKEY_MAX ? String(i + 1) : undefined);
  const textKey = hotkey(options.length);
  return [
    options.length > 0 &&
      html`<div class="doptions">${options.map((o, i) => {
        const k = hotkey(i);
        return html`<button key=${o} type="button" class=${'btn dopt' + (draft?.option === o ? ' on' : '')} aria-pressed=${draft?.option === o ? 'true' : 'false'} aria-keyshortcuts=${k} disabled=${sending} onClick=${() => {
          if (instant) {
            setDraft(key, { option: o, error: undefined });
            void sendAnswer(key);
          } else toggleOption(key, o);
        }}>${k && html`<kbd class="dkey" aria-hidden="true">${k}</kbd>`}<span class="dtext"><span class="dlabel">${LinkedText(o)}</span>${notes[o] && html`<span class="dnote">: ${notes[o]}</span>`}</span></button>`;
      })}</div>`,
    instant && options.length > 0 && draft?.option && draft?.error && html`<div class="bad derr">${draft.error}</div>`,
    // The dock's composer, one box as in a chat app: the text box across the full width, then a slim
    // toolbar inside the same box, attach at its left and Send at its right.
    !permission &&
      html`<div class="dcompose"><div class="danswer-wrap">${textKey && html`<kbd class="dkey dkey-text" aria-hidden="true">${textKey}</kbd>`}<textarea
      class="danswer"
      rows="2"
      aria-keyshortcuts=${textKey}
      aria-label=${options.length && !instant ? 'Your answer, in your own words' : 'Your answer'}
      placeholder=${options.length && !instant ? 'Add to your answer, or answer in your own words' : 'Your answer'}
      value=${text}
      disabled=${sending}
      onInput=${(e: Event) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        grow(el);
        setDraft(key, { text: el.value, error: undefined });
      }}
      onPaste=${can('answer-files') ? (e: ClipboardEvent) => void pasteImages(key, e) : undefined}
      onKeyDown=${onSendKey(
        () => !getState().drafts[key]?.sending,
        () => void sendAnswer(key),
      )}
    ></textarea></div><div class="dtools">${
      can('answer-files') &&
      html`<label class="btn dattach dicon" title="Attach images or files">${AttachIcon}<input
          type="file"
          multiple
          aria-label="Attach"
          accept=${accept}
          disabled=${sending}
          onChange=${(e: Event) => {
            const input = e.currentTarget as HTMLInputElement;
            void addFiles(key, input.files).then(() => {
              input.value = '';
            });
          }}
        /></label>`
    }${!touch && html`<${SendHint} />`}<button type="button" class="btn dsend dicon" aria-label="Send" aria-keyshortcuts=${sendShortcut()} title=${sending ? 'Sending…' : 'Send'} aria-busy=${sending} disabled=${sending} onClick=${() => void sendAnswer(key)}>${SendIcon}</button></div></div>`,
    !permission &&
      (files.length > 0 || (draft?.error && !(instant && draft.option))) &&
      html`<div class="dfoot">
      ${files.map(
        (f, i) =>
          html`<span key=${f.name + i} class="dchip">${f.name}<button type="button" class="dx" title="remove" disabled=${sending} onClick=${() => removeFile(key, i)}>×</button></span>`,
      )}
      ${draft?.error && !(instant && draft.option) && html`<span class="bad derr">${draft.error}</span>`}
    </div>`,
  ];
}

/** The dock's icons: a paperclip to attach, and the paper plane of Material's `send` to send. Each button carries its own label. */
const AttachIcon = html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>`;
const SendIcon = html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>`;

/** A decision's title: the helm's, or the worker's note for a raw question. */
const titleOf = (c: DecisionCard) => (c.kind === 'decision' ? LinkedText(c.title) : NamedText(c.note));

/** A decision's state in plain words. */
const STATE_WORD = { unread: 'new', read: 'seen', answered: 'sent' } as const;

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
    c.repo && RepoName(c.repo),
  ].filter(Boolean);
  return parts.flatMap((m, i) => (i ? [' · ', m] : [m]));
}

/**
 * A decision on the deck: one row, the whole of it a button that opens the
 * decision. The question, then its repo and age, then "sent" once answered
 * or a run card's run state once it has run; a run card names its boat.
 * Highlighted while unread. Who asked and the dispatch are in the decision itself.
 */
function row(c: DecisionCard, draft: DecisionDraft | undefined, viewedHere: boolean, focused: boolean) {
  const state = stateOf(c, draft, viewedHere);
  const run = c.kind === 'decision' ? c.run : undefined;
  // A run card's status is its icon; one declined from this page shows the declined icon.
  const runNow = run?.latest && runStatus(run.latest.state, run.latest.result);
  const runIcon = run && (runNow ?? (state === 'answered' && draft?.option === RUN_DECLINE ? 'declined' : undefined));
  const open = () => openDecision(c.key);
  // The hosted glass names the card's boat; the local glass is on it.
  const boat = run ? (run.boat ?? getState().snapshot?.viewer?.machine) : undefined;
  const meta = [c.repo && RepoName(c.repo), [Age(c.at), ' ago']].filter(Boolean).flatMap((m, i) => (i ? [' · ', m] : [m]));
  const status = runIcon
    ? html`<span class="dsent"><${RunStatusIcon} status=${runIcon} result=${run?.latest?.result} startedAt=${run?.latest?.startedAt} /></span>`
    : state === 'answered' && html`<span class="dsent ok">sent</span>`;
  return html`<li key=${c.key} class=${'drow ' + state + (focused ? ' focus' : '')} data-decision=${c.key}>
    <button type="button" class="dopen" onClick=${open} aria-label=${`${STATE_WORD[state]}: ${c.kind === 'decision' ? c.title : c.note}`}>
      ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
      <b class="dtitle">${titleOf(c)}</b>
      <span class="dmeta dim">${meta}</span>
      ${boat && html`<span class="dboat dim">⛵ ${boat}</span>`}
      ${status}
    </button>
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
function legend(options: number, permission = false) {
  const pick = Math.min(options, HOTKEY_MAX);
  const text = !permission && options + 1 <= HOTKEY_MAX ? String(options + 1) : undefined;
  const parts = [
    pick > 0 && [html`<kbd>1</kbd>`, pick > 1 && ['–', html`<kbd>${pick}</kbd>`], ' choose'],
    text && [html`<kbd>${text}</kbd>`, ' write'],
    pick > 0 && [html`<kbd>Enter</kbd>`, ' on a chosen option sends'],
    [html`<kbd>←</kbd>`, ' ', html`<kbd>→</kbd>`, ' previous / next'],
    [html`<kbd>Esc</kbd>`, permission ? ' closes' : ' leaves the text box, then closes'],
    [html`<kbd>d</kbd>`, ' opens decisions anywhere'],
  ].filter(Boolean);
  return html`<div class="dlegend dim">${parts.flatMap((p, i) => (i ? [' · ', p] : [p]))}</div>`;
}

/** How far a finger travels before a swipe steps or closes the card. */
const SWIPE_PX = 60;

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
  const swipe = useRef<{ x: number; y: number; head: boolean } | null>(null);
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    returnTo.current = document.activeElement;
    box.current?.focus();
    // On a phone the card is the visual viewport's height (glass.css --dvh), so an open keyboard never covers its dock.
    const vv = window.visualViewport;
    const fit = () => vv && box.current?.style.setProperty('--dvh', `${Math.round(vv.height)}px`);
    fit();
    vv?.addEventListener('resize', fit);
    return () => {
      vv?.removeEventListener('resize', fit);
      const back = returnTo.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [isOpen]);
  const key = open?.key ?? null;
  useEffect(() => {
    if (key) void markViewed(key);
  }, [key, order.find((c) => c.key === key)?.at]);
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
  // A swipe that starts in the text box, a field or a code block moves the text, not the card.
  const swipeStart = (e: TouchEvent) => {
    const t = e.touches[0];
    const from = e.target as Element | null;
    swipe.current =
      t && !from?.closest?.('textarea, input, select, pre, code, .runscript')
        ? { x: t.clientX, y: t.clientY, head: !!from?.closest?.('.dhead') }
        : null;
  };
  const swipeEnd = (e: TouchEvent) => {
    const start = swipe.current;
    const t = e.changedTouches[0];
    swipe.current = null;
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) stepDecision(dx < 0 ? 1 : -1);
    else if (start.head && dy >= SWIPE_PX && dy > Math.abs(dx) * 1.5) closeDecision();
  };
  // A run card stays on screen with its output after its run answers it and the snapshot drops it.
  const ran = key ? getState().runs?.[key] : undefined;
  const c = key ? (order.find((x) => x.key === key) ?? ran?.card) : undefined;
  // Its place among the open decisions; a finished run card the snapshot dropped still has neighbours.
  const near = c ? decisionNeighbours(order, c) : undefined;
  const shell = (label: string, body: unknown, shown = '') =>
    html`<div id="doverlay" class="open" onClick=${(e: Event) => e.target === e.currentTarget && closeDecision()}>
      <div class=${'modal dmodal' + (c?.kind === 'decision' && c.permission ? ' dpermission' : '')} role="dialog" aria-modal="true" aria-labelledby="dmodal-title" tabindex="-1" ref=${box} onKeyDown=${trap} onTouchStart=${swipeStart} onTouchEnd=${swipeEnd} data-decision=${shown}>
        <button type="button" class="x" aria-label="close" aria-keyshortcuts="Escape" onClick=${closeDecision}>×</button>
        <h3 id="dmodal-title" class="sr-only">${label}</h3>
        ${body}
      </div>
    </div>`;
  if (!c) {
    return shell(
      'All decisions answered',
      html`<div class="ddone" onClick=${closeDecision}><div class="ok">✓ All decisions answered.</div><div class="dim">Tap or click anywhere to close</div></div>`,
    );
  }
  const draft = drafts[c.key];
  const touch = touchOnly();
  const proposal = c.kind === 'decision' && c.permissionsProposal && !c.readOnly;
  const answer = proposal
    ? null
    : c.kind === 'decision' && !c.readOnly && c.appStart && validDesktopStartLink(c.appStart.url)
      ? html`<${DesktopStartAction} url=${c.appStart.url} decision />`
      : c.kind === 'decision' && c.readOnly
        ? html`<div class="dim">Closed decision</div>`
        : c.kind === 'decision' && c.run && (ran?.busy || ran?.result || c.run.latest)
          ? null
          : draft?.sent
            ? c.kind === 'decision' && c.run && draft.option === RUN_DECLINE
              ? html`<div class="danswered runstate"><${RunStatusIcon} status="declined" /></div>`
              : html`<div class="danswered ok">answered · ${draft.sent}</div>`
            : answerForm(c, draft, extensions.join(','));
  const showLegend = !touch && (proposal || !(c.kind === 'decision' && (c.appStart || c.readOnly)));
  return shell(
    c.kind === 'decision' ? c.title : c.note,
    html`<div class="dhead">
        <div class="dnav">
          <button type="button" class="btn dprev" aria-label="previous decision" aria-keyshortcuts="ArrowLeft" disabled=${!near?.prev} onClick=${() => stepDecision(-1)}>‹ prev</button>
          <span class="dpos" aria-live="polite">${near?.listed ? `${near.index + 1} of ${order.length}` : `${order.length} open`}</span>
          <button type="button" class="btn dnext" aria-label="next decision" aria-keyshortcuts="ArrowRight" disabled=${!near?.next} onClick=${() => stepDecision(1)}>next ›</button>
        </div>
      </div>
      <div class="dbody">
        <div class="dtop">
          ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
          <b class="dtitle">${titleOf(c)}</b>
          <span class="dmeta dim">${source(c)}${source(c).length ? ' · ' : ''}${Age(c.at)} ago</span>
        </div>
        ${
          proposal
            ? html`<${PermissionsProposalCard} card=${c} draft=${draft} />`
            : [
                c.kind === 'decision' &&
                  c.detail.trim() &&
                  html`<${Markdown} text=${c.detail} documentKey=${c.key} readOnly=${c.readOnly || !!draft?.sent} fileUrl=${(name: string) => fileUrl({ kind: 'decision', key: c.key }, name)} />`,
                c.kind === 'decision' && attachments(c.key, c.attachments),
                c.kind === 'decision' && c.run && html`<${RunCardBody} cardKey=${c.key} run=${c.run} readOnly=${c.readOnly} />`,
              ]
        }
      </div>
      <div class="ddock">
        ${answer}
        ${showLegend && legend(proposal ? 0 : c.kind === 'decision' ? c.options.length : 0, proposal || (c.kind === 'decision' && !!c.permission))}
      </div>`,
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
