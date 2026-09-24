import type { GlassSnapshot } from '@lobstah/core';
import { modalItem } from '../../src/glass-diff.js';
import type { GlassPrefs, ModalType } from '../../src/glass-diff.js';
import { saveLobHidden, savePrefs } from './prefs.js';
import { getState, setState } from './store.js';

/** Everything the page can do: each action updates the store (and localStorage for preferences). */

/** A new snapshot; an open modal whose item vanished closes and stays closed. */
export function receive(snapshot: GlassSnapshot): void {
  const { modal } = getState();
  setState({ snapshot, stale: false, modal: modal && modalItem(snapshot, modal) ? modal : null });
}

export const markStale = (): void => setState({ stale: true });

export function showModal(type: ModalType, key: string): void {
  const { snapshot } = getState();
  const modal = { type, key };
  setState({ modal: !snapshot || modalItem(snapshot, modal) ? modal : null });
}

export const closeModal = (): void => setState({ modal: null });

export function setPrefs(patch: Partial<GlassPrefs>): void {
  const prefs = { ...getState().prefs, ...patch };
  savePrefs(prefs);
  setState({ prefs });
}

export function setView(v: string): void {
  if (v !== 'table' && v !== 'cards') return;
  setPrefs({ view: v });
}

export const setLobs = (v: string): void => setPrefs({ lobs: v === 'on' });

/** Hide a clicked lob in this browser until its state hash changes. Deferred, so a PR lob's link still follows. */
export function hideLob(key: string, hash: string): void {
  const lobHidden = { ...getState().lobHidden, [key]: hash };
  saveLobHidden(lobHidden);
  setTimeout(() => setState({ lobHidden }), 0);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}
