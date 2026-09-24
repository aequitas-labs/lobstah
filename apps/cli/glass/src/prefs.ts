import type { GlassPrefs } from '../../src/glass-diff.js';

/**
 * This browser's preferences and filters, kept in localStorage — the
 * server has nothing to write. `spyglass` holds the view, the lobs switch,
 * and the filters; `spyglass-lob-hidden` holds the lobs this browser
 * clicked (item key → the state hash hidden).
 */

export const st: GlassPrefs = { view: 'table', lane: '', repo: '', verb: '', q: '', lobs: true, chain: false, noticeKind: '' };
try {
  Object.assign(st, JSON.parse(localStorage.getItem('spyglass') || '{}'));
} catch (e) {}
// A stored value this page doesn't understand falls back to the default.
if (st.view !== 'table' && st.view !== 'cards') st.view = 'table';
st.lobs = st.lobs !== false;

export const save = (): void => {
  try {
    localStorage.setItem('spyglass', JSON.stringify(st));
  } catch (e) {}
};

// Per-browser lob hides: {itemKey: stateHash}. localStorage only, guarded like st.
export let lobHidden: Record<string, string> = {};
try {
  lobHidden = JSON.parse(localStorage.getItem('spyglass-lob-hidden') || '{}') || {};
} catch (e) {
  lobHidden = {};
}

export const hideLobPref = (key: string, hash: string): void => {
  lobHidden[key] = hash;
  try {
    localStorage.setItem('spyglass-lob-hidden', JSON.stringify(lobHidden));
  } catch (e) {}
};
