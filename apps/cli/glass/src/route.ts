import { GLASS_TABS, tabFromHash } from '../../src/glass-diff.js';
import type { GlassTab } from '../../src/glass-diff.js';

/** The tabs are hash routes: #deck (the default), #dispatches, #traps, #prs, #notices. */
export const TABS = GLASS_TABS;
export const activeTab = (): GlassTab => tabFromHash(location.hash);

/** Show the active tab's page and mark its link. */
export function showTab(tab: GlassTab): void {
  for (const name of TABS) document.getElementById('page-' + name)!.classList.toggle('on', name === tab);
  for (const a of document.querySelectorAll<HTMLElement>('#tabs a')) a.classList.toggle('on', a.dataset.tab === tab);
}

/** Re-render on every route change. */
export const onRoute = (fn: () => void): void => window.addEventListener('hashchange', fn);
