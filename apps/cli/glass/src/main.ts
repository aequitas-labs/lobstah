import { h, render } from 'preact';
import { decisionFromHash } from '../../src/glass-diff.js';
import { closeModal, loadOpenReport } from './actions.js';
import { App } from './components/app.js';
import { startPolling } from './poll.js';
import { loadLobHidden, loadPrefs } from './prefs.js';
import { currentModal, currentRoute, onRoute } from './route.js';
import { getState, initState, setState, subscribe } from './store.js';

/**
 * The spyglass page's entry point: build the store from localStorage and
 * the URL, render App into the body on every change, and start polling.
 */

initState({
  snapshot: undefined,
  route: currentRoute(),
  prefs: loadPrefs(),
  modal: currentModal(),
  stale: false,
  lobHidden: loadLobHidden(),
  spriteOk: null,
  focusResults: {},
  preview: new URLSearchParams(location.search).has('lob'),
  reportText: {},
  drafts: {},
  focusDecision: decisionFromHash(location.hash),
});

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

// Probe the lob sprite once; either way the lobs re-render.
const sprite = new Image();
sprite.onload = () => setState({ spriteOk: true });
sprite.onerror = () => setState({ spriteOk: false });
sprite.src = '/lob-sprite.png';

onRoute((route) => {
  const modal = currentModal();
  const focusDecision = decisionFromHash(location.hash);
  if (focusDecision !== getState().focusDecision) scrolledTo = null;
  setState(modal ? { route, modal, focusDecision } : { route, focusDecision });
  if (modal) loadOpenReport();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
startPolling();
