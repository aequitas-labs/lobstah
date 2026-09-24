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

const paint = () => render(h(App, { state: getState() }), document.body);
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
