import { GLASS_TABS, sectionInputs } from '../../../src/glass-diff.js';
import type { GlassTab } from '../../../src/glass-diff.js';
import { closeModal } from '../actions.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import type { GlassState } from '../store.js';
import { Deck } from './deck.js';
import { Dispatches } from './dispatches.js';
import { Footer, Header } from './header.js';
import { Lobs } from './lobs.js';
import { Modal } from './modals.js';
import { Notices } from './notices.js';
import { PRs } from './prs.js';
import { Traps } from './traps.js';

/**
 * The whole page as a pure function of the store. Only the active tab's
 * section renders; the others are empty until opened. Rows, cards, and
 * lobs are keyed, so a new snapshot changes only the DOM whose data changed.
 */
export function App({ state }: { state: GlassState }) {
  const d = state.snapshot;
  const tab = state.route;
  const inp = d && sectionInputs(d, { st: state.prefs, modal: state.modal }, Date.now());
  const page = (t: GlassTab): Children => {
    if (!inp || t !== tab) return null;
    if (t === 'deck') return html`<${Deck} inp=${inp.deck} />`;
    if (t === 'dispatches') return html`<${Dispatches} inp=${inp.dispatches} />`;
    if (t === 'traps') return html`<${Traps} inp=${inp.traps} />`;
    if (t === 'prs') return html`<${PRs} inp=${inp.prs} />`;
    return html`<${Notices} inp=${inp.notices} />`;
  };
  const onOverlay = (e: Event) => {
    if (e.target === e.currentTarget) closeModal();
  };
  return [
    html`<${Header} d=${d} inp=${inp} tab=${tab} st=${state.prefs} stale=${state.stale} />`,
    GLASS_TABS.map(
      (t) =>
        html`<main key=${t} id=${'page-' + t} class=${d ? (t === tab ? 'tabpage on' : 'tabpage') : 'tabpage'}><div id=${t}>${page(t)}</div></main>`,
    ),
    html`<footer id="foot"><${Footer} d=${d} /></footer>`,
    html`<div id="lobs"><${Lobs} state=${state} /></div>`,
    html`<div id="overlay" class=${state.modal && d ? 'open' : d ? '' : undefined} onClick=${onOverlay}><div class="modal" id="modalbox"><${Modal} snapshot=${d} modal=${state.modal} prefs=${state.prefs} /></div></div>`,
  ];
}
