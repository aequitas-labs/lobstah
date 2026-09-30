import { tabFromHash } from '../../src/glass-diff.js';
import type { GlassTab } from '../../src/glass-diff.js';

/** The tabs are hash routes: #deck (the default), #dispatches, #traps, #prs, #notices. */
export const currentRoute = (): GlassTab => tabFromHash(location.hash);

/** Call fn with the new tab on every route change. */
export const onRoute = (fn: (tab: GlassTab) => void): void => window.addEventListener('hashchange', () => fn(currentRoute()));
