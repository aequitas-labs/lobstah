import { DecisionRow } from './decision-row.js';
import { ThreadNotes } from './helm.js';
import { Composer } from './composer.js';
import { DesktopStartAction } from './common.js';
import { validDesktopStartLink } from '../../../core/src/desktop-start-link.js';
import type { Attachment, GlassHandoff, RecentRun, RunResult } from '@lobstah/core';
import { useEffect, useRef } from 'preact/hooks';
import { decisionNeighbours, isOpenDecision } from '../../src/glass-diff.js';
import type { DecisionCard } from '../../src/glass-diff.js';
import {
  HOTKEY_MAX,
  closeDecision,
  dismissAlert,
  markViewed,
  modalOrder,
  openDecision,
  sendAnswer,
  setDraft,
  decisionOnScreen,
  stepDecision,
  toggleOption,
} from '../actions.js';
import { html } from '../html.js';
import type { DecisionDraft } from '../store.js';
import { getState } from '../store.js';
import { Age, ImageThumb, NamedText, RepoName, opener } from './common.js';
import { Markdown } from './report.js';
import { LinkedText } from './links.js';
import { SectionHead } from './section-head.js';
import { PermissionsProposalCard } from './permissions-proposal.js';
import { RunActions, RunCardBody } from './run-card.js';
import { RUN_DECLINE, RunKindIcon, RunStatusIcon, runStatus } from './run-status.js';
import type { RunStatus } from './run-status.js';
import { fileUrl } from '../backend.js';
import { touchOnly } from '../send-key.js';
import { Button } from './button.js';
import { Toast } from './toast.js';
import { DecisionEmbeds, DecisionPrTags } from './decision-embeds.js';

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

function attachments(key: string, list: Attachment[]) {
  if (!list.length) return null;
  return html`<div class="dfiles">${list.map((a) =>
    IMAGE.test(a.name)
      ? html`<span key=${a.name}>${ImageThumb(fileUrl({ kind: 'decision', key }, a.name), a.name, 'dimg')}</span>`
      : html`<div key=${a.name} class="dfile"><span>${a.name}</span> <span class="dim">· ${a.type} · ${a.bytes} bytes · </span><code>${a.path}</code></div>`,
  )}</div>`;
}

/** `hotkeys` is false outside the modal, where number keys do not choose. */
function answerForm(c: DecisionCard, draft: DecisionDraft | undefined, accept: string, hotkeys = true) {
  const key = c.key;
  // A permission card takes only an explicit option; a text reply can't grant anything.
  const permission = c.kind === 'decision' && c.permission;
  // A run card's options (Decline) send at once, like a permission card's; it also takes a reply. Run is its own button.
  const instant = permission || (c.kind === 'decision' && !!c.run);
  const options = c.kind === 'decision' ? c.options : [];
  const notes = (c.kind === 'decision' && c.optionNotes) || {};
  const sending = !!draft?.sending;
  // 1..N choose an option, N+1 the text field; only 1–9 are keys, and none on a touch screen.
  const touch = touchOnly();
  const hotkey = (i: number) => (hotkeys && !touch && i + 1 <= HOTKEY_MAX ? String(i + 1) : undefined);
  const textKey = hotkey(options.length);
  // A run card's one option, Decline, sits in the run row beside Run (RunDecline).
  const shown = c.kind === 'decision' && c.run ? [] : options;
  return [
    shown.length > 0 &&
      html`<div class="doptions">${shown.map((o, i) => {
        const k = hotkey(i);
        return html`<${Button} key=${o} size="lg" class="dopt" pressed=${draft?.option === o} aria-keyshortcuts=${k} disabled=${sending} onClick=${() => {
          if (instant) {
            setDraft(key, { option: o, error: undefined });
            void sendAnswer(key);
          } else toggleOption(key, o);
        }}>${k && html`<kbd class="dkey" aria-hidden="true">${k}</kbd>`}<span class="dtext"><span class="dlabel">${LinkedText(o)}</span>${notes[o] && html`<span class="dnote">: ${notes[o]}</span>`}</span><//>`;
      })}</div>`,
    instant &&
      options.length > 0 &&
      draft?.option &&
      draft?.error &&
      html`<div class="dfoot"><span class="bad derr" role="alert">${draft.error}</span>${draft.failed && html`<${Button} class="dretry" onClick=${() => void sendAnswer(key)}>Retry<//>`}</div>`,
    !permission &&
      html`<${Composer} draftKey=${key} draft=${draft} accept=${accept} textKey=${textKey} label=${options.length && !instant ? 'Your answer, in your own words' : 'Your answer'} placeholder=${options.length && !instant ? 'Add to your answer, or answer in your own words' : 'Your answer'} onSend=${() => sendAnswer(key)} hideError=${!!(instant && draft?.option)} />`,
  ];
}

/**
 * A standing card's answer form inside its conversation. It shares the
 * modal's draft, so an answer here answers the card and the modal shows it
 * sent. Cards that run, grant access or start an app answer in the modal
 * only; for those, and for a card not open here, it renders nothing.
 */
export function InlineDecisionAnswer({ cardKey }: { cardKey: string }) {
  const state = getState();
  const draft = state.drafts[cardKey];
  if (draft?.sent) return html`<div class="danswered ok">answered · ${draft.sent}</div>`;
  const c = modalOrder().find((card) => card.key === cardKey);
  if (c?.kind !== 'decision' || c.readOnly || c.handoff || c.permission || c.permissionsProposal || c.run || c.appStart) return null;
  return html`<div class="thread-card-answer">${answerForm(c, draft, (state.snapshot?.answerLimits?.extensions ?? []).join(','), false)}</div>`;
}

/**
 * A run card's Decline, beside Run in the run row: it sends at once, with
 * anything typed in the answer box as the reason. It keeps the option's
 * class, so its number key and Enter work as any option's do.
 */
function RunDecline({ c, draft }: { c: DecisionCard; draft: DecisionDraft | undefined }) {
  const option = (c.kind === 'decision' && c.options[0]) || RUN_DECLINE;
  const k = touchOnly() ? undefined : '1';
  const on = draft?.option === option;
  return html`<${Button} size="lg" class="dopt rundecline" pressed=${on} aria-keyshortcuts=${k} disabled=${!!draft?.sending} onClick=${() => {
    setDraft(c.key, { option, error: undefined });
    void sendAnswer(c.key);
  }}>${k && html`<kbd class="dkey" aria-hidden="true">${k}</kbd>`}<span class="dtext"><span class="dlabel">${LinkedText(option)}</span></span><//>`;
}

/** A decision's title: the helm's, or the worker's note for a raw question. */
const titleOf = (c: DecisionCard) => (c.kind === 'decision' ? LinkedText(c.title) : NamedText(c.note));

/** A decision's state in plain words. */
const STATE_WORD = { unread: 'new', read: 'seen', answered: 'sent' } as const;

/** Unread, read, or answered (from this page, or handed to the helm until it clears). */
function stateOf(c: DecisionCard, draft: DecisionDraft | undefined, viewedHere: boolean): 'unread' | 'read' | 'answered' {
  if (draft?.sent || (c.kind === 'decision' && c.handoff)) return 'answered';
  return c.viewedAt || viewedHere ? 'read' : 'unread';
}

/**
 * An answered card's hand-off, drawn as a run card's status icon alone: a
 * spinner while the helm takes the answer up, then a check once it acks.
 * The words are the icon's accessible name and tooltip.
 */
function HandoffIcon({ handoff }: { handoff: GlassHandoff }) {
  const acked = handoff.state === 'acked';
  return html`<${RunStatusIcon} status=${acked ? 'succeeded' : 'running'} label=${acked ? 'Helm has it' : 'Helm is on it'} />`;
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
  const handoff = c.kind === 'decision' ? c.handoff : undefined;
  const status = runIcon
    ? html`<span class="dsent"><${RunStatusIcon} status=${runIcon} result=${run?.latest?.result} startedAt=${run?.latest?.startedAt} /></span>`
    : handoff
      ? html`<span class="dsent"><${HandoffIcon} handoff=${handoff} /></span>`
      : state === 'answered' && html`<span class="dsent ok">sent</span>`;
  return html`<${DecisionRow}
    key=${c.key} state=${state} focused=${focused} attrs=${{ 'data-decision': c.key }} onOpen=${open}
    label=${`${STATE_WORD[state]}: ${c.kind === 'decision' ? c.title : c.note}`}
    title=${titleOf(c)}
    prefix=${[c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`, run && RunKindIcon]}
    context=${c.kind === 'decision' && c.thread && html`<span class="dim">${getState().snapshot?.threads?.find((t) => t.id === c.thread)?.title ?? 'Conversation'}</span>`}
    meta=${meta} boat=${boat && `⛵ ${boat}`} status=${status}
  />`;
}

/** How a finished run ended, as the run card's status icon shows it: its status, and the result its words name. */
function recentRunIcon(r: RecentRun) {
  const status: RunStatus = r.timedOut ? 'timed-out' : r.state;
  const result: RunResult | undefined =
    r.exitCode === undefined
      ? undefined
      : {
          exitCode: r.exitCode,
          timedOut: r.timedOut === true,
          stopped: r.state === 'stopped',
          durationMs: r.durationMs ?? 0,
          outputBytes: 0,
          scrubbed: 0,
        };
  return html`<span class="dsent"><${RunStatusIcon} status=${status} result=${result} /></span>`;
}

/**
 * Runs that finished and left the decisions, closed until opened. A row opens
 * its card, read-only, with the run's result.
 */
function RecentRuns({ runs }: { runs: RecentRun[] }) {
  if (!runs.length) return null;
  return html`<details class="recent-runs"><summary class="dim">Recent runs (${runs.length})</summary><ul class="dlist">${runs.map(
    (r) =>
      html`<li key=${r.key} class="recent-run"><a class="drow" href=${`#decision/${encodeURIComponent(r.key)}`}>${RunKindIcon}<b class="dtitle">${r.title}</b><span class="dmeta dim">${r.repo ? [RepoName(r.repo), ' · '] : ''}${Age(r.finishedAt)} ago${r.exitCode !== undefined ? ` · exit ${r.exitCode}` : ''}</span>${recentRunIcon(r)}</a></li>`,
  )}</ul></details>`;
}

export function DeckDecisions({
  cards,
  drafts,
  focus,
  viewedHere,
  unread,
  recentRuns = [],
}: {
  cards: DecisionCard[];
  drafts: Record<string, DecisionDraft>;
  focus: string | null;
  viewedHere: Record<string, true>;
  unread: number;
  recentRuns?: RecentRun[];
}) {
  const ordered = [...cards].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const shown = ordered;
  const body = shown.length
    ? html`<ul class="dlist">${shown.map((c) => row(c, drafts[c.key], !!viewedHere[c.key], c.key === focus))}</ul>`
    : html`<div class="empty">none</div>`;
  const heading = html`<${SectionHead} title="Decisions" count=${cards.filter(isOpenDecision).length} badge=${unread > 0 && html`<span class="dbadge" aria-label=${`${unread} new`}>${unread}</span>`} />`;
  return html`<section class="decisions">${heading}${body}<${RecentRuns} runs=${recentRuns} /></section>`;
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
  const c = key ? decisionOnScreen(key, order) : undefined;
  // Its place among the open decisions; a card that is not among them (a finished run, a hand-off) still has neighbours.
  const near = c ? decisionNeighbours(order, c) : undefined;
  const shell = (label: string, body: unknown, shown = '') =>
    html`<div id="doverlay" class="open" onClick=${(e: Event) => e.target === e.currentTarget && closeDecision()}>
      <div class=${'modal dmodal' + (c?.kind === 'decision' && c.permission ? ' dpermission' : '')} role="dialog" aria-modal="true" aria-labelledby="dmodal-title" tabindex="-1" ref=${box} onKeyDown=${trap} onTouchStart=${swipeStart} onTouchEnd=${swipeEnd} data-decision=${shown}>
        <${Button} variant="icon" class="x" label="close" aria-keyshortcuts="Escape" onClick=${closeDecision}>×<//>
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
  const run = c.kind === 'decision' && !proposal ? c.run : undefined;
  const handoff = c.kind === 'decision' && !c.readOnly ? c.handoff : undefined;
  const runRow = (decline: boolean) =>
    run &&
    html`<${RunActions} cardKey=${c.key} run=${run} readOnly=${c.kind === 'decision' && c.readOnly} decline=${decline && html`<${RunDecline} c=${c} draft=${draft} />`} />`;
  const answer = proposal
    ? null
    : c.kind === 'decision' && !c.readOnly && c.appStart && validDesktopStartLink(c.appStart.url)
      ? html`<${DesktopStartAction} url=${c.appStart.url} decision />`
      : handoff
        ? html`<div class="danswered runstate"><${HandoffIcon} handoff=${handoff} /></div>`
        : c.kind === 'decision' && c.readOnly
          ? [runRow(false), !(run && ran?.busy) && html`<div class="dim">Closed decision</div>`]
          : run && (ran?.busy || ran?.result || run.latest)
            ? runRow(false)
            : draft?.sent
              ? c.kind === 'decision' && c.run && draft.option === RUN_DECLINE
                ? html`<div class="danswered runstate"><${RunStatusIcon} status="declined" /></div>`
                : html`<div class="danswered ok">answered · ${draft.sent}</div>`
              : [runRow(true), answerForm(c, draft, extensions.join(','))];
  const showLegend = !touch && !handoff && (proposal || !(c.kind === 'decision' && (c.appStart || c.readOnly)));
  return shell(
    c.kind === 'decision' ? c.title : c.note,
    html`<div class="dhead">
        <div class="dnav">
          <${Button} class="dprev" aria-label="previous decision" aria-keyshortcuts="ArrowLeft" disabled=${!near?.prev} onClick=${() => stepDecision(-1)}>‹ prev<//>
          <span class="dpos" aria-live="polite">${near?.listed ? `${near.index + 1} of ${order.length}` : `${order.length} open`}</span>
          <${Button} class="dnext" aria-label="next decision" aria-keyshortcuts="ArrowRight" disabled=${!near?.next} onClick=${() => stepDecision(1)}>next ›<//>
        </div>
      </div>
      <div class="dbody">
        ${c.kind === 'decision' && c.thread && html`<${ThreadNotes} id=${c.thread} />`}
        <div class="dtop">
          ${c.kind === 'question' && html`<span class=${'badge ' + (c.verb === 'blocked' ? 'bad' : 'warn')}>${c.verb}</span>`}
          <b class="dtitle">${titleOf(c)}</b>
          <span class="dmeta dim">${source(c)}${source(c).length ? ' · ' : ''}${Age(c.at)} ago</span>
          ${c.kind === 'decision' && html`<${DecisionPrTags} card=${c} />`}
        </div>
        ${
          proposal
            ? html`<${PermissionsProposalCard} card=${c} draft=${draft} />`
            : [
                c.kind === 'decision' &&
                  c.detail.trim() &&
                  html`<${Markdown} text=${c.detail} documentKey=${c.key} readOnly=${c.readOnly || !!draft?.sent || !!handoff} fileUrl=${(name: string) => fileUrl({ kind: 'decision', key: c.key }, name)} />`,
                c.kind === 'decision' && attachments(c.key, c.attachments),
                c.kind === 'decision' && !!c.references?.length && html`<${DecisionEmbeds} references=${c.references} />`,
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
  return (
    show &&
    html`<${Toast} class="dalert dalert-live" duration=${null} onDismiss=${dismissAlert}>
      <button type="button" class="dalert-open" aria-keyshortcuts="d" onClick=${() => openDecision()}><span class="dcount" aria-hidden="true">${n}</span> <span>${words}</span></button>
    <//>`
  );
}
