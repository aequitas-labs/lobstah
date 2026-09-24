import type { GlassSnapshot } from '@lobstah/core';
import type { GlassPrefs, GlassTab, ModalRef } from '../../src/glass-diff.js';

/**
 * The page's one store. Every component is a pure function of this state;
 * a change replaces the state object and re-renders the page, and Preact's
 * reconciliation touches only the DOM that differs.
 */
export interface GlassState {
  /** The latest /data snapshot; undefined until the first fetch lands. */
  snapshot: GlassSnapshot | undefined;
  /** The tab, from the URL hash. */
  route: GlassTab;
  /** This browser's preferences and filters (localStorage). */
  prefs: GlassPrefs;
  /** The open modal, if any. */
  modal: ModalRef | null;
  /** The last fetch failed. */
  stale: boolean;
  /** Lobs this browser clicked: item key → the state hash hidden (localStorage). */
  lobHidden: Record<string, string>;
  /** The lob sprite loaded (true), failed (false), or is still probing (null). */
  spriteOk: boolean | null;
  /** The ?lob page parameter: show a sample lob when nothing is waiting. */
  preview: boolean;
}

let current: GlassState;
const listeners = new Set<(s: GlassState) => void>();

export const getState = (): GlassState => current;
export function initState(s: GlassState): void {
  current = s;
}
export function setState(patch: Partial<GlassState>): void {
  current = { ...current, ...patch };
  for (const fn of listeners) fn(current);
}
export const subscribe = (fn: (s: GlassState) => void): void => {
  listeners.add(fn);
};
