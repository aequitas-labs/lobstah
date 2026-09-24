import type { GlassSnapshot } from '@lobstah/core';
import type { ModalRef, SectionHashes } from '../../src/glass-diff.js';

/**
 * The page's mutable state, in one place: the latest snapshot, the open
 * modal, and the section hashes the last render wrote. Preferences live in
 * prefs.ts; the route is the URL hash (route.ts).
 */
export const state: {
  last: GlassSnapshot | undefined;
  modal: ModalRef | null;
  /** Row keys a reader expanded (window.tog); kept for the page's console API. */
  open: Set<string>;
  hashes: Partial<SectionHashes>;
} = { last: undefined, modal: null, open: new Set(), hashes: {} };
