import type { GlassPrefs } from '../../src/glass-diff.js';

/**
 * This browser's preferences and filters, kept in localStorage — the
 * server has nothing to write. `spyglass` holds the view, the lobs switch,
 * and the filters; `spyglass-lob-hidden` holds the lobs this browser
 * clicked (item key → the state hash hidden).
 */

export function loadPrefs(): GlassPrefs {
  const st: GlassPrefs = { view: 'table', lane: '', repo: '', verb: '', q: '', lobs: true, chain: false, noticeKind: '' };
  try {
    Object.assign(st, JSON.parse(localStorage.getItem('spyglass') || '{}'));
  } catch (e) {}
  // A stored value this page doesn't understand falls back to the default.
  if (st.view !== 'table' && st.view !== 'cards') st.view = 'table';
  st.lobs = st.lobs !== false;
  return st;
}

export function savePrefs(st: GlassPrefs): void {
  try {
    localStorage.setItem('spyglass', JSON.stringify(st));
  } catch (e) {}
}

export function loadLobHidden(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('spyglass-lob-hidden') || '{}') || {};
  } catch (e) {
    return {};
  }
}

export function saveLobHidden(hidden: Record<string, string>): void {
  try {
    localStorage.setItem('spyglass-lob-hidden', JSON.stringify(hidden));
  } catch (e) {}
}
