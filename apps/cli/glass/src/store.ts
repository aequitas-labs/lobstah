import type { GlassOlderKind, GlassSnapshot, StatsPage } from '@lobstah/core';
import { withOlder } from '../../src/glass-diff.js';
import type { DispatchDetail, GlassOlder, GlassPrefs, GlassTab, ModalRef } from '../../src/glass-diff.js';

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
  /** The open dispatch modal's detail: its brief, log, inbox, and evidence. */
  detail: DispatchDetail | null;
  /** History paged in from /data/older, and the kind whose page is on its way. */
  older: GlassOlder;
  olderLoading: GlassOlderKind | null;
  olderError: { kind: GlassOlderKind; text: string } | null;
  /** The last fetch failed. */
  stale: boolean;
  /** Lobs this browser clicked: item key → the state hash hidden (localStorage). */
  lobHidden: Record<string, string>;
  /** Last focus outcome per trap, visible beside the action. */
  focusResults: Record<string, string>;
  /** The ?lob page parameter: show a sample lob when nothing is waiting. */
  preview: boolean;
  /** Answers being written on the deck's decision cards, by card key. */
  drafts: Record<string, DecisionDraft>;
  /** The card a `#decision/<key>` link points at. */
  focusDecision: string | null;
  /**
   * The decision modal: the decision it shows, or `key: null` for the
   * "all decisions answered" state. Separate from `modal`, so it opens over
   * another modal without closing it.
   */
  decisionModal: { key: string | null } | null;
  /** Decisions this page showed in the modal (its view POST may still be on its way). */
  viewedHere: Record<string, true>;
  /** The unread decisions the new-decision alert was dismissed for; a new one shows it again. */
  alertDismissed: string[];
  /** The image open in the in-page overlay, if any. */
  lightbox: Lightbox | null;
  /** The Stats tab's data (/data/stats), fetched while that tab is open. */
  stats: StatsPage | null;
  statsError: string | null;
  /** The heatmap day that holds keyboard focus (the grid's one tab stop). */
  statsFocus: string | null;
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
let viewed: { snapshot: GlassSnapshot; older: GlassOlder; view: GlassSnapshot } | undefined;

/** The snapshot the page renders: the last poll with the history paged in after it. */
export function viewOf(s: Pick<GlassState, 'snapshot' | 'older'>): GlassSnapshot | undefined {
  if (!s.snapshot) return undefined;
  if (viewed?.snapshot !== s.snapshot || viewed.older !== s.older)
    viewed = { snapshot: s.snapshot, older: s.older, view: withOlder(s.snapshot, s.older) };
  return viewed.view;
}
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
