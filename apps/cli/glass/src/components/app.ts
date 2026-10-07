import { GLASS_TABS, olderLeft, sectionInputs } from '../../../src/glass-diff.js';
import type { GlassOlderKind } from '@lobstah/core';
import type { GlassTab } from '../../../src/glass-diff.js';
import { closeModal, modalOrder, unreadOrder } from '../actions.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { viewOf } from '../store.js';
import type { GlassState } from '../store.js';
import type { OlderControl } from './common.js';
import { Deck } from './deck.js';
import { DecisionAlert, DecisionModal } from './decisions.js';
import { Dispatches } from './dispatches.js';
import { Footer, Header } from './header.js';
import { Lobs } from './lobs.js';
import { LightboxView } from './lightbox.js';
import { Modal } from './modals.js';
import { Notices } from './notices.js';
import { PRs } from './prs.js';
import { Reports } from './reports.js';
import { Stats } from './stats.js';
import { Traps } from './traps.js';

/**
 * The whole page as a pure function of the store. Only the active tab's
 * section renders; the others are empty until opened. Rows, cards, and
 * lobs are keyed, so a new snapshot changes only the DOM whose data changed.
 */
export function App({ state }: { state: GlassState }) {
  const d = viewOf(state);
  const tab = state.route;
  const unread = d ? unreadOrder() : [];
  const inp = d && sectionInputs(d, { st: state.prefs, modal: state.modal, detail: state.detail }, Date.now());
  const more = (kind: GlassOlderKind): OlderControl => ({
    left: state.snapshot ? olderLeft(state.snapshot, state.older, kind) : 0,
    loading: state.olderLoading === kind,
    error: state.olderError?.kind === kind ? state.olderError.text : undefined,
  });
  const page = (t: GlassTab): Children => {
    if (!inp || t !== tab) return null;
    if (t === 'deck')
      return html`<${Deck} inp=${inp.deck} drafts=${state.drafts} focus=${state.focusDecision} viewedHere=${state.viewedHere} unread=${unread.length} />`;
    if (t === 'dispatches') return html`<${Dispatches} inp=${inp.dispatches} more=${more('dispatches')} />`;
    if (t === 'traps') return html`<${Traps} inp=${inp.traps} />`;
    if (t === 'prs') return html`<${PRs} inp=${inp.prs} more=${more('prs')} />`;
    if (t === 'reports') return html`<${Reports} inp=${inp.reports} />`;
    if (t === 'stats') return html`<${Stats} page=${state.stats} error=${state.statsError} focus=${state.statsFocus} />`;
    return html`<${Notices} inp=${inp.notices} more=${more('notices')} />`;
  };
  const onOverlay = (e: Event) => {
    if (e.target === e.currentTarget) closeModal();
  };
  return [
    html`<${Header} d=${d} inp=${inp} tab=${tab} st=${state.prefs} stale=${state.stale} unread=${unread.length} />`,
    GLASS_TABS.map(
      (t) =>
        html`<main key=${t} id=${'page-' + t} class=${d ? (t === tab ? 'tabpage on' : 'tabpage') : 'tabpage'}><div id=${t}>${page(t)}</div></main>`,
    ),
    html`<footer id="foot"><${Footer} d=${d} /></footer>`,
    html`<div id="lobs"><${Lobs} state=${state} /></div>`,
    html`<${LightboxView} box=${state.lightbox} />`,
    html`<div id="overlay" class=${state.modal && d ? 'open' : d ? '' : undefined} onClick=${onOverlay}><div class="modal" id="modalbox"><${Modal} snapshot=${d} modal=${state.modal} prefs=${state.prefs} detail=${state.detail} /></div></div>`,
    d &&
      html`<${DecisionModal} open=${state.decisionModal} order=${modalOrder()} drafts=${state.drafts} extensions=${d.answerLimits?.extensions ?? []} />`,
    d && html`<${DecisionAlert} unread=${unread} dismissed=${state.alertDismissed} />`,
  ];
}
