import { h, render } from 'preact';
import type { GlassSnapshot } from '@lobstah/core';
import { NO_OLDER, prFromHash, decisionFromHash, reportFromHash, reportFromPath } from '../src/glass-diff.js';
import {
  closeDecision,
  closeLightbox,
  closeModal,
  closeReportSheet,
  decisionNumberKey,
  loadSettings,
  loadStats,
  openDecision,
  receive,
  reviewRequest,
  routeReport,
  routePrView,
  sendAnswer,
  showModal,
  stepDecision,
} from './actions.js';
import { App } from './components/app.js';
import { ReportShell, loadReportView, markReportViewed } from './components/report-view.js';
import type { ReportViewState } from './components/report-view.js';
import { poll, setLive, startPolling } from './poll.js';
import { startPresence } from './presence.js';
import { loadLobHidden, loadPrefs } from './prefs.js';
import { currentRoute, onRoute } from './route.js';
import { getState, initState, setState, subscribe } from './store.js';
import type { GlassState } from './store.js';
import { setBackend } from './backend.js';
import type { GlassBackend } from './backend.js';
import { setHost } from './host.js';
import type { GlassHost } from './host.js';

/**
 * The spyglass page. On `/report/<key>` it renders that report
 * once and stops. Otherwise it builds the store from localStorage and the
 * URL, renders App into the body on every change, and starts polling.
 * Either page reports its presence, so the pet can show an item in it.
 * A `#report/<key>` link opens that report in the sheet over the glass.
 */

const initialState = (): GlassState => ({
  snapshot: undefined,
  route: currentRoute(),
  reportSheet: reportFromHash(location.hash),
  prefs: location.hash.startsWith('#review-') ? { ...loadPrefs(), repo: '', q: '' } : loadPrefs(),
  modal: prFromHash(location.hash) ? { type: 'pr', key: prFromHash(location.hash)! } : null,
  detail: null,
  older: NO_OLDER,
  olderLoading: null,
  olderError: null,
  stale: false,
  lobHidden: loadLobHidden(),
  focusResults: {},
  preview: new URLSearchParams(location.search).has('lob'),
  drafts: {},
  focusDecision: decisionFromHash(location.hash),
  decisionModal: decisionFromHash(location.hash) ? { key: decisionFromHash(location.hash) } : null,
  viewedHere: {},
  alertDismissed: [],
  lightbox: null,
  stats: null,
  statsError: null,
  settings: null,
  settingsError: null,
  statsFocus: null,
});

/**
 * Start a glass page on this backend: the report page on `/report/<key>`,
 * otherwise the glass. Each host's entry calls this once.
 */
export function startGlassPage(source: GlassBackend, parts: GlassHost = {}): GlassPage {
  setBackend(source);
  setHost(parts);
  const reportKey = reportFromPath(location.pathname);
  const stops: Array<() => void> = [];
  if (reportKey !== null) stops.push(...startReportPage(reportKey));
  else stops.push(...startGlass());
  return {
    refresh: poll,
    live: setLive,
    apply: receive,
    repaint: () => setState({}),
    open(item) {
      pendingOpen = item;
      openPending();
    },
    stop() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}

/** A started glass page, for its host: read again now, repaint, open an item, or stop for good. */
export interface GlassPage {
  /** Read the snapshot now (pushed events arrived). */
  refresh(): Promise<void>;
  /** The host's live socket opened (no polling timer) or closed (polling resumes). */
  live(open: boolean): void;
  /** Show a snapshot the host built from pushed data, with no request. */
  apply(snapshot: GlassSnapshot): void;
  /** Paint again: the host's own parts changed. */
  repaint(): void;
  /** Open a dispatch or trap once the snapshot lists it (a link named it). */
  open(item: { kind: 'dispatch' | 'trap'; id: string }): void;
  /** No more polls, renders, keys or presence: the host signed out. */
  stop(): void;
}

let pendingOpen: { kind: 'dispatch' | 'trap'; id: string } | undefined;

/** Open the item a link named, once the snapshot lists it. */
function openPending(): void {
  const d = getState().snapshot;
  if (!pendingOpen || !d) return;
  const { kind, id } = pendingOpen;
  pendingOpen = undefined;
  if (kind === 'trap') {
    if (d.traps.some((t) => t.trapId === id)) showModal('trap', id);
  } else {
    const x = d.dispatches.find((v) => v.id === id);
    if (x) showModal('dispatch', `${x.lane}:${x.id}`);
  }
}

/** One report's page: loaded once, re-rendered only when its image overlay opens or closes. */
function startReportPage(key: string): Array<() => void> {
  initState(initialState());
  let view: ReportViewState = { state: 'loading' };
  const paint = () => render(h(ReportShell, { view, box: getState().lightbox }), document.body);
  document.title = 'report · lobstah glass';
  const unsubscribe = subscribe(paint);
  paint();
  const presence = startPresence(2000);
  void loadReportView(key).then((loaded) => {
    view = loaded;
    if (loaded.state === 'ready') document.title = `${loaded.report.title} · lobstah glass`;
    paint();
    // Shown: the human has opened it, so ack it.
    void markReportViewed(loaded);
  });
  const escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && getState().lightbox) closeLightbox();
  };
  document.addEventListener('keydown', escape);
  return [unsubscribe, presence, () => document.removeEventListener('keydown', escape)];
}

function startGlass(): Array<() => void> {
  initState(initialState());

  let paintedRoute: ReturnType<typeof currentRoute> | undefined;
  let hadSnapshot = false;
  let reviewScrolled: string | null = null;
  const paint = () => {
    const state = getState();
    const enteredTab = state.route !== paintedRoute || (!hadSnapshot && !!state.snapshot);
    render(h(App, { state }), document.body);
    paintedRoute = state.route;
    hadSnapshot ||= !!state.snapshot;
    // Hash navigation can target a hidden tab before it renders. Reset only on
    // entry, never on a poll that refreshes the tab someone is reading.
    if (enteredTab) window.scrollTo(0, 0);
    if (!state.focusDecision) scrolledTo = null;
    scrollToDecision(state.focusDecision);
    const match = /^#review-(.+)$/.exec(location.hash);
    if (match) {
      let key: string;
      try {
        key = decodeURIComponent(match[1]!);
      } catch {
        return;
      }
      const row = [...document.querySelectorAll('[data-review]')].find((el) => el.getAttribute('data-review') === key);
      if (row && reviewScrolled !== key) {
        reviewScrolled = key;
        row.scrollIntoView?.({ block: 'center' });
      }
    } else reviewScrolled = null;
  };

  /** A `#decision/<key>` link scrolls to its card once, when the card first renders. */
  let scrolledTo: string | null = null;
  function scrollToDecision(key: string | null): void {
    if (!key || key === scrolledTo) return;
    const card = [...document.querySelectorAll('[data-decision]')].find((el) => el.getAttribute('data-decision') === key);
    if (!card) return;
    scrolledTo = key;
    card.scrollIntoView?.({ block: 'center' });
  }
  const unsubscribe = subscribe((state) => {
    paint();
    // A link named a dispatch or trap before the snapshot listed it.
    if (pendingOpen && state.snapshot) openPending();
  });
  paint();

  const unroute = onRoute((route) => {
    const pr = prFromHash(location.hash);
    routePrView(pr);
    if (pr) return;
    // A report opens in the sheet over the tab, which keeps its place underneath.
    const report = reportFromHash(location.hash);
    routeReport(report);
    if (report !== null) return;
    const focusDecision = decisionFromHash(location.hash);
    if (focusDecision !== getState().focusDecision) scrolledTo = null;
    setState({
      route,
      focusDecision,
      ...(location.hash.startsWith('#review-') ? { prefs: { ...getState().prefs, repo: '', q: '' } } : {}),
    });
    // A `#decision/<key>` link (a lob, the pet) opens that decision too.
    if (focusDecision) openDecision(focusDecision);
    if (route === 'stats') void loadStats();
    if (route === 'settings') void loadSettings();
  });
  /** Whether a key lands in something the person is typing into. */
  const typing = (t: HTMLElement | null): boolean =>
    !!t && (!!t.closest?.('input, textarea, select, [contenteditable]') || t.isContentEditable === true);
  /**
   * The keys. Escape closes the topmost layer, and in the decision modal it
   * leaves the text field first. The hotkeys (d, 1–9, Enter on a chosen
   * option, ←/→) never fire while typing in a field, with cmd/ctrl/alt held,
   * during IME composition, or while another layer is on top. No single key
   * answers a decision: a number selects, Enter on the selected option sends.
   */
  const keys = (e: KeyboardEvent) => {
    const state = getState();
    const t = e.target as HTMLElement | null;
    if (e.key === 'Escape') {
      // Topmost first: the image overlay, then the decision modal, then the report sheet, then the modal.
      if (state.lightbox) closeLightbox();
      else if (state.decisionModal) {
        if (typing(t) && t!.closest?.('.dmodal')) {
          t!.blur();
          document.querySelector<HTMLElement>('.dmodal')?.focus();
        } else closeDecision();
      } else if (state.reportSheet) closeReportSheet();
      else closeModal();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.keyCode === 229 || typing(t) || state.lightbox) return;
    if (state.decisionModal) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        stepDecision(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (/^[1-9]$/.test(e.key)) {
        if (decisionNumberKey(Number(e.key))) e.preventDefault();
      } else if (e.key === 'Enter' && t?.matches?.('.dmodal .dopt.on') && state.decisionModal.key) {
        // The deliberate second action: Enter on the option a number (or a click) chose.
        e.preventDefault();
        void sendAnswer(state.decisionModal.key);
      }
      return;
    }
    // d opens the decision modal from anywhere, unless another modal is open.
    if (e.key === 'd' && !e.shiftKey && !state.modal) {
      e.preventDefault();
      openDecision();
    }
  };
  document.addEventListener('keydown', keys);
  const presence = startPresence();
  const polling = startPolling();
  if (getState().route === 'stats') void loadStats();
  if (getState().route === 'settings') void loadSettings();
  return [unsubscribe, unroute, presence, polling, () => document.removeEventListener('keydown', keys)];
}
