import { h, render } from 'preact';
import { NO_OLDER, decisionFromHash, reportFromHash, reportFromPath, reportPageUrl } from '../../src/glass-diff.js';
import { closeLightbox, closeModal } from './actions.js';
import { App } from './components/app.js';
import { ReportShell, loadReportView } from './components/report-view.js';
import type { ReportViewState } from './components/report-view.js';
import { startPolling } from './poll.js';
import { startPresence } from './presence.js';
import { loadLobHidden, loadPrefs } from './prefs.js';
import { currentRoute, onRoute } from './route.js';
import { getState, initState, setState, subscribe } from './store.js';
import type { GlassState } from './store.js';

/**
 * The spyglass page's entry point. On `/report/<key>` it renders that report
 * once and stops. Otherwise it builds the store from localStorage and the
 * URL, renders App into the body on every change, and starts polling.
 * Either page reports its presence, so the pet can show an item in it.
 * A `#report/<key>` link goes to the report's page.
 */

/** An old `#report/<key>` link: replace it with the report's page. */
function reportRedirect(): boolean {
  const key = reportFromHash(location.hash);
  if (key === null) return false;
  location.replace(reportPageUrl(key));
  return true;
}

const initialState = (): GlassState => ({
  snapshot: undefined,
  route: currentRoute(),
  prefs: loadPrefs(),
  modal: null,
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
  lightbox: null,
});

const reportKey = reportFromPath(location.pathname);
if (reportKey !== null) {
  startReportPage(reportKey);
} else if (!reportRedirect()) {
  startGlass();
}

/** One report's page: loaded once, re-rendered only when its image overlay opens or closes. */
function startReportPage(key: string): void {
  initState(initialState());
  let view: ReportViewState = { state: 'loading' };
  const paint = () => render(h(ReportShell, { view, box: getState().lightbox }), document.body);
  document.title = 'report · lobstah glass';
  subscribe(paint);
  paint();
  startPresence(2000);
  void loadReportView(key).then((loaded) => {
    view = loaded;
    if (loaded.state === 'ready') document.title = `${loaded.report.title} · lobstah glass`;
    paint();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getState().lightbox) closeLightbox();
  });
}

function startGlass(): void {
  initState(initialState());

  let paintedRoute: ReturnType<typeof currentRoute> | undefined;
  let hadSnapshot = false;
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
  subscribe(paint);
  paint();

  onRoute((route) => {
    if (reportRedirect()) return;
    const focusDecision = decisionFromHash(location.hash);
    if (focusDecision !== getState().focusDecision) scrolledTo = null;
    setState({ route, focusDecision });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The image overlay sits above a modal: Escape closes it first.
    if (getState().lightbox) closeLightbox();
    else closeModal();
  });
  startPresence();
  startPolling();
}
