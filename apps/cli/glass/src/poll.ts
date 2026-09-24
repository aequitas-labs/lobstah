import type { GlassSnapshot } from '@lobstah/core';
import { dirtySections, hashInputs, sectionInputs, visibleSections } from '../../src/glass-diff.js';
import type { Html } from './html.js';
import { st } from './prefs.js';
import { activeTab, showTab } from './route.js';
import { state } from './state.js';
import { refreshAges } from './render/common.js';
import { renderDeck } from './render/deck.js';
import { dispatchCards, dispatchTable } from './render/dispatches.js';
import { renderChips, renderControls, renderFoot } from './render/header.js';
import { renderLobs } from './render/lobs.js';
import { renderModal } from './render/modals.js';
import { noticeTable } from './render/notices.js';
import { prCards, prTable } from './render/prs.js';
import { trapCards, trapTable } from './render/traps.js';

/**
 * Polling and rendering. /data is fetched every 2s, one request at a time,
 * and not at all while the tab is hidden. Each section renders only when
 * the hash of its inputs changed (glass-diff.ts), so a quiet tick touches
 * nothing but ticking ages and the clock.
 */

// Rewrite one section, keeping any horizontal/vertical scroll inside it.
function setHTML(id: string, markup: Html): void {
  const el = document.getElementById(id)!;
  const sc = [...el.querySelectorAll('.wrap')].map((w) => [w.scrollLeft, w.scrollTop] as const);
  el.innerHTML = markup.value;
  el.querySelectorAll('.wrap').forEach((w, i) => {
    const at = sc[i];
    if (at) {
      w.scrollLeft = at[0];
      w.scrollTop = at[1];
    }
  });
}

export function render(d: GlassSnapshot): void {
  const inp = sectionInputs(d, { st, open: state.open, modal: state.modal }, Date.now());
  const next = hashInputs(inp);
  const dirty = new Set(dirtySections(state.hashes, next));
  const tab = activeTab();
  const visible = new Set(visibleSections(tab));
  for (const k of visible) state.hashes[k] = next[k];
  showTab(tab);
  renderControls(d, tab);
  if (dirty.has('chips')) setHTML('chips', renderChips(d, inp.chips));
  if (tab === 'deck' && dirty.has('deck')) setHTML('deck', renderDeck(inp.deck));
  if (tab === 'dispatches' && dirty.has('dispatches')) {
    const list = inp.dispatches.list;
    setHTML('dispatches', st.view === 'cards' ? dispatchCards(list) : dispatchTable(list, st));
  }
  if (tab === 'traps' && dirty.has('traps')) {
    const traps = inp.traps.list.map((t) => t.x);
    setHTML('traps', st.view === 'cards' ? trapCards(traps) : trapTable(traps));
  }
  if (tab === 'notices' && dirty.has('notices')) setHTML('notices', noticeTable(inp.notices.list));
  if (tab === 'prs' && dirty.has('prs')) setHTML('prs', st.view === 'cards' ? prCards(inp.prs) : prTable(inp.prs));
  if (dirty.has('foot')) setHTML('foot', renderFoot(d));
  renderLobs(d.attention || [], state.last);
  // The open modal is rebuilt only when its own item (or which one) changed.
  if (dirty.has('modal')) renderModal(d);
  refreshAges();
}

let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

const setStale = (on: boolean) => {
  const el = document.getElementById('stale')!;
  const v = on ? 'inline' : 'none';
  if (el.style.display !== v) el.style.display = v;
};

// User-driven ticks render synchronously from the last snapshot; polls fetch one at a time.
export async function tick(rerender?: boolean): Promise<void> {
  if (rerender && state.last) {
    render(state.last);
    return;
  }
  if (inflight) return;
  inflight = true;
  try {
    const r = await fetch('/data');
    state.last = (await r.json()) as GlassSnapshot;
    render(state.last);
    setStale(false);
  } catch (e) {
    setStale(true);
  } finally {
    inflight = false;
  }
}

const startPoll = () => {
  if (!timer) timer = setInterval(() => tick(false), 2000);
};
const stopPoll = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/** First fetch now; poll while the tab is visible, pause while hidden. */
export function startPolling(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else {
      tick(false);
      startPoll();
    }
  });
  tick();
  if (!document.hidden) startPoll();
}
