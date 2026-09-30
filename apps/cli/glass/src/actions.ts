import type { GlassSnapshot } from '@lobstah/core';
import { modalItem, reportMarkdownUrl } from '../../src/glass-diff.js';
import type { GlassPrefs, ModalType } from '../../src/glass-diff.js';
import { saveLobHidden, savePrefs } from './prefs.js';
import { getState, setState } from './store.js';

/** Everything the page can do: each action updates the store (and localStorage for preferences). */

/** A new snapshot; an open modal whose item vanished closes and stays closed. */
export function receive(snapshot: GlassSnapshot): void {
  const { modal } = getState();
  setState({ snapshot, stale: false, modal: modal && modalItem(snapshot, modal) ? modal : null });
  loadOpenReport();
}

/**
 * Fetch the open modal's report page once per filing. Opening a report
 * reads it; it never acks it (only `lobstah attention ack` does).
 */
export function loadOpenReport(): void {
  const { snapshot, modal, reportText } = getState();
  if (!snapshot || !modal) return;
  const r =
    modal.type === 'report'
      ? (snapshot.reports || []).find((x) => x.key === modal.key)
      : modal.type === 'dispatch'
        ? (snapshot.reports || []).find((x) => 'report:' + modal.key === x.key)
        : undefined;
  if (!r || reportText[r.key]?.hash === r.stateHash) return;
  const key = r.key;
  const hash = r.stateHash;
  const put = (entry: { text?: string; error?: string }) =>
    setState({ reportText: { ...getState().reportText, [key]: { hash, ...entry } } });
  put({});
  fetch(reportMarkdownUrl(key))
    .then(async (res) => (res.ok === false ? put({ error: `report not found (${res.status})` }) : put({ text: await res.text() })))
    .catch(() => put({ error: 'report could not be read' }));
}

export const markStale = (): void => setState({ stale: true });

export function showModal(type: ModalType, key: string): void {
  const { snapshot } = getState();
  const modal = { type, key };
  setState({ modal: !snapshot || modalItem(snapshot, modal) ? modal : null });
  loadOpenReport();
}

/** Close the modal; a #report/<key> deep link gives way to the deck. */
export function closeModal(): void {
  if (/^#report\//.test(location.hash)) history.replaceState(null, '', '#deck');
  setState({ modal: null });
}

/** Ask the local server to focus one live trap; it accepts no path, URL, or command. */
export async function openTrapWindow(trapId: string): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) return;
  try {
    const response = await fetch(`/api/focus/${encodeURIComponent(trapId)}`, {
      method: 'POST',
      headers: { 'x-lobstah-focus-token': token },
    });
    const result = (await response.json()) as { message?: string; reason?: string };
    setState({ focusResults: { ...getState().focusResults, [trapId]: result.message ?? result.reason ?? 'Window focus failed.' } });
  } catch {
    setState({ focusResults: { ...getState().focusResults, [trapId]: 'Window focus failed.' } });
  }
}

/**
 * Ask the helm for a new trap: the server writes a trap-request and runs
 * nothing. Resolves to an error reason, or undefined on success; a fresh
 * snapshot follows at once so the requested card shows.
 */
export async function requestTrap(repo: string, harness: string): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return 'The glass has no page token yet.';
  try {
    const response = await fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-token': token },
      body: JSON.stringify({ kind: 'trap-request', payload: { repo, harness } }),
    });
    const result = (await response.json()) as { ok?: boolean; reason?: string };
    if (!result.ok) return result.reason ?? 'The request was refused.';
  } catch {
    return 'The request could not be sent.';
  }
  try {
    receive((await (await fetch('/data')).json()) as GlassSnapshot);
  } catch {
    // the next poll shows it
  }
  return undefined;
}

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
