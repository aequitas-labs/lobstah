import { tabFromHash } from '../src/glass-diff.js';
import type { GlassRoute, GlassTab } from '../src/glass-diff.js';
import { visibleTabs } from './backend.js';

/** The tabs are hash routes: #deck (the default), #dispatches, #traps, #prs, #reviews, #reports, #notices, #stats, #settings. */
export const currentRoute = (): GlassRoute => {
  if (location.hash === '#decisions') return 'deck';
  const tab = tabFromHash(location.hash);
  // A tab this page's source does not fill opens the deck, as an unknown hash does.
  return visibleTabs().includes(tab) ? tab : 'deck';
};

/** Call fn with the new tab on every route change. */
export const onRoute = (fn: (tab: GlassRoute) => void): (() => void) => {
  const changed = () => fn(currentRoute());
  window.addEventListener('hashchange', changed);
  window.addEventListener('popstate', changed);
  return () => {
    window.removeEventListener('hashchange', changed);
    window.removeEventListener('popstate', changed);
  };
};

/** A tab switches without an anchor jump; selecting the active tab scrolls to its content. */
export function navigateTab(event: MouseEvent, target: GlassTab): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
  event.preventDefault();
  if (currentRoute() === target) {
    history.replaceState(history.state, '', '#' + target);
    const section = document.getElementById(target);
    if (section) window.scrollTo(0, window.scrollY + section.getBoundingClientRect().top);
    return;
  }
  const { glassOverlay: _overlay, ...state } = history.state ?? {};
  history.pushState(state, '', '#' + target);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
