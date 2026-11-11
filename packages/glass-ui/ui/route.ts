import { tabFromHash } from '../src/glass-diff.js';
import type { GlassTab } from '../src/glass-diff.js';
import { visibleTabs } from './backend.js';

/** The tabs are hash routes: #deck (the default), #dispatches, #traps, #prs, #reviews, #reports, #notices, #stats, #settings. */
export const currentRoute = (): GlassTab => {
  const tab = tabFromHash(location.hash);
  // A tab this page's source does not fill opens the deck, as an unknown hash does.
  return visibleTabs().includes(tab) ? tab : 'deck';
};

/** Call fn with the new tab on every route change. */
export const onRoute = (fn: (tab: GlassTab) => void): (() => void) => {
  const changed = () => fn(currentRoute());
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
};
