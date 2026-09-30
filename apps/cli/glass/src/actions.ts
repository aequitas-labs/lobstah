import type { GlassSnapshot } from '@lobstah/core';
import { answerSummary, decisionAnswerUrl, decisionCards, modalItem, reportMarkdownUrl } from '../../src/glass-diff.js';
import type { GlassPrefs, ModalType } from '../../src/glass-diff.js';
import { saveLobHidden, savePrefs } from './prefs.js';
import { getState, setState } from './store.js';
import type { DecisionDraft, DraftFile } from './store.js';

/** Everything the page can do: each action updates the store (and localStorage for preferences). */

/** A new snapshot; an open modal whose item vanished closes and stays closed. */
export function receive(snapshot: GlassSnapshot): void {
  const { modal, drafts } = getState();
  // A card that left the snapshot (answered, withdrawn) takes its draft with it.
  const live = new Set(decisionCards(snapshot.attention || [], snapshot.decisions || []).map((c) => c.key));
  const kept = Object.fromEntries(Object.entries(drafts).filter(([key]) => live.has(key)));
  setState({
    snapshot,
    stale: false,
    modal: modal && modalItem(snapshot, modal) ? modal : null,
    ...(Object.keys(kept).length !== Object.keys(drafts).length ? { drafts: kept } : {}),
  });
  loadOpenReport();
}

const emptyDraft = (): DecisionDraft => ({ text: '', files: [] });

/** Change one card's draft. */
export function setDraft(key: string, patch: Partial<DecisionDraft>): void {
  const drafts = getState().drafts;
  setState({ drafts: { ...drafts, [key]: { ...(drafts[key] ?? emptyDraft()), ...patch } } });
}

/** Choose an option, or clear it when it is chosen already. */
export function toggleOption(key: string, option: string): void {
  const current = getState().drafts[key]?.option;
  setDraft(key, { option: current === option ? undefined : option, error: undefined });
}

const readBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Add picked files to a card's answer, refusing what the server would refuse. */
export async function addFiles(key: string, list: FileList | File[] | null): Promise<void> {
  const limits = getState().snapshot?.answerLimits;
  const picked = [...(list ?? [])];
  const current = getState().drafts[key]?.files ?? [];
  const errors: string[] = [];
  const added: DraftFile[] = [];
  for (const file of picked) {
    const ext = (/\.[^.]+$/.exec(file.name)?.[0] ?? '').toLowerCase();
    if (limits && !limits.extensions.includes(ext)) errors.push(`${file.name}: type not accepted`);
    else if (limits && file.size > limits.maxBytes) errors.push(`${file.name}: larger than ${limits.maxBytes} bytes`);
    else if (limits && current.length + added.length >= limits.maxFiles) errors.push(`${file.name}: at most ${limits.maxFiles} files`);
    else {
      try {
        added.push({ name: file.name, bytes: file.size, data: await readBase64(file) });
      } catch {
        errors.push(`${file.name}: could not be read`);
      }
    }
  }
  setDraft(key, { files: [...(getState().drafts[key]?.files ?? []), ...added], error: errors.length ? errors.join('; ') : undefined });
}

export function removeFile(key: string, index: number): void {
  const files = (getState().drafts[key]?.files ?? []).filter((_, i) => i !== index);
  setDraft(key, { files });
}

/** Send a card's answer: one same-origin POST with the page's token. The server stores it; the helm acts on it. */
export async function sendAnswer(key: string): Promise<void> {
  const token = getState().snapshot?.focusToken;
  const draft = getState().drafts[key] ?? emptyDraft();
  if (draft.sending || draft.sent) return;
  if (!draft.option && !draft.text.trim() && draft.files.length === 0) {
    setDraft(key, { error: 'Choose an option, write an answer, or attach a file.' });
    return;
  }
  if (!token) {
    setDraft(key, { error: 'This page has no answer token; reload it.' });
    return;
  }
  setDraft(key, { sending: true, error: undefined });
  try {
    const response = await fetch(decisionAnswerUrl(key), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-focus-token': token },
      body: JSON.stringify({
        ...(draft.option ? { option: draft.option } : {}),
        ...(draft.text.trim() ? { text: draft.text } : {}),
        files: draft.files.map((f) => ({ name: f.name, data: f.data })),
      }),
    });
    const result = (await response.json()) as { answered?: boolean; reason?: string };
    if (!response.ok || !result.answered) {
      setDraft(key, { sending: false, error: result.reason ?? `The answer was refused (${response.status}).` });
      return;
    }
    setDraft(key, { sending: false, sent: answerSummary({ option: draft.option, text: draft.text, files: draft.files.length }) });
  } catch {
    setDraft(key, { sending: false, error: 'The answer could not be sent.' });
  }
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
