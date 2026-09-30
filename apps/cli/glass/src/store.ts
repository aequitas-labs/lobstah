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
  /** Last focus outcome per trap, visible beside the action. */
  focusResults: Record<string, string>;
  /** The ?lob page parameter: show a sample lob when nothing is waiting. */
  preview: boolean;
  /** Answers being written on the deck's decision cards, by card key. */
  drafts: Record<string, DecisionDraft>;
  /** The card a `#decision/<key>` link points at. */
  focusDecision: string | null;
  /** The image open in the in-page overlay, if any. */
  lightbox: Lightbox | null;
}

/** An image shown over the page: where it loads from, and its name. */
export interface Lightbox {
  src: string;
  name: string;
}

/** A file picked for an answer, read as base64 for the POST. */
export interface DraftFile {
  name: string;
  bytes: number;
  data: string;
}

/** One card's answer in progress, or the answer it sent. */
export interface DecisionDraft {
  option?: string;
  text: string;
  files: DraftFile[];
  sending?: boolean;
  error?: string;
  /** Set once the server stored the answer: what the card says it sent. */
  sent?: string;
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
