import type { GlassBeats, GlassDispatch, GlassOlderKind, GlassOlderPage, GlassSnapshot, StatsPage } from '@lobstah/core';
import { addOlder, answerSummary, applyBeats, decisionCards, modalItem, openDecisionOrder, unreadDecisions } from '../../src/glass-diff.js';
import type { GlassPrefs, ModalRef, ModalType } from '../../src/glass-diff.js';
import { saveLobHidden, savePrefs } from './prefs.js';
import { getState, setState, viewOf } from './store.js';
import type { GlassState } from './store.js';
import type { DecisionDraft, DraftFile } from './store.js';

/** Everything the page can do: each action updates the store (and localStorage for preferences). */

/**
 * Whether the open modal still has something to show. A dispatch modal
 * stays open while its detail loads or holds it, even for a dispatch the
 * poll left out (an old catch opened from its trap).
 */
function modalLives(s: Pick<GlassState, 'snapshot' | 'older' | 'detail'>, modal: ModalRef): boolean {
  const view = viewOf(s);
  if (view && modalItem(view, modal, s.detail)) return true;
  return modal.type === 'dispatch' && s.detail?.key === modal.key && !s.detail.error;
}

/** A new snapshot; an open modal whose item vanished closes and stays closed. */
export function receive(snapshot: GlassSnapshot): void {
  const { modal, drafts, older, detail, decisionModal } = getState();
  // A card that left the snapshot (answered, withdrawn) takes its draft with it.
  const cards = decisionCards(snapshot.attention || [], snapshot.decisions || []);
  const live = new Set(cards.map((c) => c.key));
  const kept = Object.fromEntries(Object.entries(drafts).filter(([key]) => live.has(key)));
  setState({
    snapshot,
    stale: false,
    modal: modal && modalLives({ snapshot, older, detail }, modal) ? modal : null,
    ...(Object.keys(kept).length !== Object.keys(drafts).length ? { drafts: kept } : {}),
    // The shown decision left (answered elsewhere, withdrawn): show the oldest open one, or close.
    ...(decisionModal?.key && !live.has(decisionModal.key) && !drafts[decisionModal.key]?.sent
      ? { decisionModal: nextOpen(cards, kept, decisionModal.key) }
      : {}),
  });
}

/** The decision after `key` in the modal's order (oldest first), else the first; null key when none is open. */
function nextOpen(
  cards: ReturnType<typeof decisionCards>,
  drafts: Record<string, DecisionDraft>,
  key: string | null,
): { key: string | null } | null {
  const order = openDecisionOrder(cards, (k) => !!drafts[k]?.sent || k === key);
  if (!order.length) return null;
  const at = cards.find((c) => c.key === key)?.at ?? '';
  return { key: (order.find((c) => c.at > at || (c.at === at && c.key > (key ?? ''))) ?? order[0]!).key };
}

/** The cards the page shows now. */
function currentCards() {
  const view = viewOf(getState());
  return view ? decisionCards(view.attention || [], view.decisions || []) : [];
}

/** The open decisions the modal steps through, oldest first. */
export function modalOrder(): ReturnType<typeof decisionCards> {
  const { drafts } = getState();
  return openDecisionOrder(currentCards(), (k) => !!drafts[k]?.sent);
}

/** The unread decisions, oldest first: the alert's and the badge's count. */
export function unreadOrder(): ReturnType<typeof decisionCards> {
  const { drafts, viewedHere } = getState();
  return unreadDecisions(
    currentCards(),
    (k) => !!drafts[k]?.sent,
    (k) => !!viewedHere[k],
  );
}

/** Open the decision modal at `key`, else at the oldest unread decision, else the oldest open one. */
export function openDecision(key?: string): void {
  const target = key ?? unreadOrder()[0]?.key ?? modalOrder()[0]?.key;
  if (!target) return;
  setState({ decisionModal: { key: target } });
}

/** Previous (-1) or next (+1) in the modal's order. It never wraps and never sends anything. */
export function stepDecision(dir: -1 | 1): void {
  const open = getState().decisionModal;
  if (!open?.key) return;
  const order = modalOrder();
  const i = order.findIndex((c) => c.key === open.key);
  const next = order[i + dir];
  if (i >= 0 && next) setState({ decisionModal: { key: next.key } });
}

export const closeDecision = (): void => setState({ decisionModal: null });

/** Hotkeys reach the first nine answers only: 1–9. */
export const HOTKEY_MAX = 9;

/** The decision the modal shows now, if any. */
function shownDecision() {
  const key = getState().decisionModal?.key;
  return key ? modalOrder().find((c) => c.key === key) : undefined;
}

/**
 * A number key in the decision modal: 1..N selects option N (and focuses
 * it), and N+1 focuses the text field (the open answer counts as an
 * option). Only 1–9 are keys. It never sends: Enter on the selected option,
 * or Send, does. Returns whether the key did something.
 */
export function decisionNumberKey(n: number): boolean {
  const c = shownDecision();
  if (!c || n < 1 || n > HOTKEY_MAX) return false;
  const draft = getState().drafts[c.key];
  if (draft?.sending || draft?.sent) return false;
  const options = c.kind === 'decision' ? c.options : [];
  if (n <= options.length) {
    setDraft(c.key, { option: options[n - 1], error: undefined });
    document.querySelectorAll<HTMLElement>('.dmodal .dopt')[n - 1]?.focus();
    return true;
  }
  if (n === options.length + 1) {
    document.querySelector<HTMLElement>('.dmodal textarea.danswer')?.focus();
    return true;
  }
  return false;
}

/**
 * The modal displayed a decision: record its first view on the server
 * (`decision-viewed`), once per page. State only: it answers nothing.
 */
export async function markViewed(key: string): Promise<void> {
  const state = getState();
  if (state.viewedHere[key]) return;
  setState({ viewedHere: { ...state.viewedHere, [key]: true } });
  if (currentCards().find((c) => c.key === key)?.viewedAt) return;
  const token = state.snapshot?.focusToken;
  if (!token) return;
  try {
    await fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-token': token },
      body: JSON.stringify({ kind: 'decision-viewed', payload: { key } }),
    });
  } catch {
    // The next view tries again on a fresh page; the count here already treats it as seen.
  }
}

/** Dismiss the new-decision alert for the decisions unread now. It marks nothing read. */
export function dismissAlert(): void {
  setState({ alertDismissed: unreadOrder().map((c) => c.key) });
}

/** A 304: nothing a person reads changed; only the server time and heartbeats ticked. */
export function receiveBeats(beats: GlassBeats): void {
  const { snapshot } = getState();
  setState({ stale: false, ...(snapshot ? { snapshot: applyBeats(snapshot, beats) } : {}) });
}

/** Fetch the open dispatch modal's detail; a later modal or a newer answer wins. */
export async function refreshDetail(): Promise<void> {
  const { modal } = getState();
  if (modal?.type !== 'dispatch') return;
  const key = modal.key;
  const id = key.slice(key.indexOf(':') + 1);
  let next: { data?: GlassDispatch; error?: string };
  try {
    const r = await fetch(`/data/dispatch/${encodeURIComponent(id)}`, { cache: 'no-store' });
    next = r.ok
      ? { data: (await r.json()) as GlassDispatch }
      : { error: r.status === 404 ? 'this dispatch is gone' : `the detail answered ${r.status}` };
  } catch {
    next = { error: 'the detail could not be read' };
  }
  const now = getState();
  if (now.modal?.type !== 'dispatch' || now.modal.key !== key) return;
  // A failed refresh keeps the detail already shown.
  if (next.error && now.detail?.key === key && now.detail.data) return;
  setState({ detail: { key, ...next } });
}

/** Fetch the Stats tab's numbers and heatmap (local stats.json, read-only). One request at a time. */
let statsInflight = false;
export async function loadStats(): Promise<void> {
  if (statsInflight) return;
  statsInflight = true;
  try {
    const r = await fetch('/data/stats', { cache: 'no-store' });
    if (!r.ok) throw new Error(`/data/stats answered ${r.status}`);
    setState({ stats: (await r.json()) as StatsPage, statsError: null });
  } catch {
    setState({ statsError: 'stats could not be read' });
  } finally {
    statsInflight = false;
  }
}

/** Move the heatmap's keyboard focus to a day. */
export const focusStatsDay = (date: string): void => {
  if (getState().statsFocus !== date) setState({ statsFocus: date });
};

/** Page in the next `/data/older` page of a kind. */
export async function loadOlder(kind: GlassOlderKind): Promise<void> {
  const { olderLoading, older } = getState();
  if (olderLoading) return;
  setState({ olderLoading: kind, olderError: null });
  try {
    const r = await fetch(`/data/older?kind=${kind}&offset=${older[kind].length}&limit=50`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`/data/older answered ${r.status}`);
    const page = (await r.json()) as GlassOlderPage;
    setState({ older: addOlder(getState().older, page), olderLoading: null });
  } catch {
    setState({ olderLoading: null, olderError: { kind, text: 'older records could not be read' } });
  }
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

const PASTE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * A paste into an answer box: each image on the clipboard becomes an
 * attachment named `pasted-<time>.png` (the extension follows the image
 * type), with the same checks as a picked file. Text pastes as text: the
 * text box's own paste is never prevented.
 */
export async function pasteImages(key: string, e: ClipboardEvent): Promise<void> {
  const items = [...(e.clipboardData?.items ?? [])];
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');
  const images = items
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null)
    .map((f, i, all) => {
      const name = `pasted-${stamp}${all.length > 1 ? `-${i + 1}` : ''}${PASTE_EXT[f.type] ?? '.png'}`;
      return new File([f], name, { type: f.type });
    });
  if (images.length) await addFiles(key, images);
}

export function removeFile(key: string, index: number): void {
  const files = (getState().drafts[key]?.files ?? []).filter((_, i) => i !== index);
  setDraft(key, { files });
}

/**
 * Send a card's answer: one same-origin POST to /requests with the page's
 * token, a `decision-answer` request. The server stores it; the helm acts on it.
 */
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
    const response = await fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-token': token },
      body: JSON.stringify({
        kind: 'decision-answer',
        payload: {
          key,
          ...(draft.option ? { option: draft.option } : {}),
          ...(draft.text.trim() ? { text: draft.text } : {}),
          files: draft.files.map((f) => ({ name: f.name, data: f.data })),
        },
      }),
    });
    const result = (await response.json()) as { ok?: boolean; reason?: string };
    if (!response.ok || !result.ok) {
      setDraft(key, { sending: false, error: result.reason ?? `The answer was refused (${response.status}).` });
      return;
    }
    setDraft(key, { sending: false, sent: answerSummary({ option: draft.option, text: draft.text, files: draft.files.length }) });
    // Answered in the modal: the next open decision loads, or the all-answered state.
    const open = getState().decisionModal;
    if (open?.key === key) setState({ decisionModal: nextOpen(currentCards(), getState().drafts, key) ?? { key: null } });
  } catch {
    setDraft(key, { sending: false, error: 'The answer could not be sent.' });
  }
}

export const markStale = (): void => setState({ stale: true });

/** Show an image in the in-page overlay. */
export const openLightbox = (src: string, name: string): void => setState({ lightbox: { src, name } });
export const closeLightbox = (): void => setState({ lightbox: null });

export function showModal(type: ModalType, key: string): void {
  const state = getState();
  const modal = { type, key };
  if (type === 'dispatch') {
    // Its detail loads now; the modal shows the summary meanwhile.
    setState({ modal, detail: state.detail?.key === key ? state.detail : { key } });
    void refreshDetail();
    return;
  }
  const view = viewOf(state);
  setState({ modal: !view || modalItem(view, modal) ? modal : null, detail: null });
}

/** Close the modal. */
export function closeModal(): void {
  setState({ modal: null, detail: null });
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
