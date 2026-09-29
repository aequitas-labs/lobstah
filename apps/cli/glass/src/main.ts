import { h, render } from 'preact';
import { closeModal } from './actions.js';
import { App } from './components/app.js';
import { startPolling } from './poll.js';
import { loadLobHidden, loadPrefs } from './prefs.js';
import { currentRoute, onRoute } from './route.js';
import { getState, initState, setState, subscribe } from './store.js';

/**
 * The spyglass page's entry point: build the store from localStorage and
 * the URL, render App into the body on every change, and start polling.
 */

initState({
  snapshot: undefined,
  route: currentRoute(),
  prefs: loadPrefs(),
  modal: null,
  stale: false,
  lobHidden: loadLobHidden(),
  spriteOk: null,
  preview: new URLSearchParams(location.search).has('lob'),
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
};
subscribe(paint);
paint();

// Probe the lob sprite once; either way the lobs re-render.
const sprite = new Image();
sprite.onload = () => setState({ spriteOk: true });
sprite.onerror = () => setState({ spriteOk: false });
sprite.src = '/lob-sprite.png';

onRoute((route) => setState({ route }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
startPolling();
