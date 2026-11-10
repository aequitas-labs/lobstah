import type { GlassSettings } from '@lobstah/core';
import type { GlassBeats, GlassDispatch, GlassOlderKind, GlassOlderPage, GlassSnapshot, StatsPage } from '@lobstah/core';
import {
  addOlder,
  answerSummary,
  applyBeats,
  decisionCards,
  filteredDecisionCards,
  modalItem,
  openDecisionOrder,
  unreadDecisions,
} from '../src/glass-diff.js';
import type { GlassPrefs, ModalRef, ModalType } from '../src/glass-diff.js';
import { saveLobHidden, savePrefs } from './prefs.js';
import { getState, setState, viewOf } from './store.js';
import type { GlassState } from './store.js';
import type { DecisionDraft, DraftFile } from './store.js';
import { setDecisionBadge } from './app-badge.js';
import { backend, can } from './backend.js';

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
  const initialLink = !getState().snapshot && decisionModal?.key;
  // A card that left the snapshot (answered, withdrawn) takes its draft with it.
  const cards = decisionCards(snapshot.attention || [], snapshot.decisions || []);
  void setDecisionBadge(cards.length);
  const live = new Set(cards.map((c) => c.key));
  const kept = Object.fromEntries(Object.entries(drafts).filter(([key]) => live.has(key)));
  setState({
    snapshot,
    viewedHere: Object.fromEntries(
      Object.entries(getState().viewedHere).filter(
        ([key]) =>
          snapshot.attention.find((a) => a.key === key)?.stateHash === getState().snapshot?.attention.find((a) => a.key === key)?.stateHash,
      ),
    ),
    stale: false,
    modal: modal && modalLives({ snapshot, older, detail }, modal) ? modal : null,
    ...(Object.keys(kept).length !== Object.keys(drafts).length ? { drafts: kept } : {}),
    // Keep the old queue slot when the shown decision leaves through a live update.
    ...(!initialLink &&
    decisionModal?.key &&
    !live.has(decisionModal.key) &&
    getState().archivedDecision?.key !== decisionModal.key &&
    !drafts[decisionModal.key]?.sent &&
    !getState().runs?.[decisionModal.key]
      ? { decisionModal: nextOpen(modalOrder(), filteredDecisionCards(snapshot, getState().prefs), kept, decisionModal.key) }
      : {}),
  });
  if (initialLink && !live.has(initialLink)) void loadClosedDecision(initialLink);
}

/** Keep the removed card's old index, clamped to the new last card; a null key shows the empty state. */
function nextOpen(
  previous: ReturnType<typeof decisionCards>,
  cards: ReturnType<typeof decisionCards>,
  drafts: Record<string, DecisionDraft>,
  key: string | null,
): { key: string | null } {
  const order = openDecisionOrder(cards, (k) => !!drafts[k]?.sent || k === key);
  const index = Math.max(
    0,
    previous.findIndex((card) => card.key === key),
  );
  return { key: order[Math.min(index, order.length - 1)]?.key ?? null };
}

/** The cards the page shows now. */
function currentCards() {
  const state = getState();
  const view = viewOf(state);
  return view ? filteredDecisionCards(view, state.prefs) : [];
}

/** The open decisions the modal steps through, oldest first. */
export function modalOrder(): ReturnType<typeof decisionCards> {
  const state = getState();
  const cards = currentCards();
  const archived = state.archivedDecision;
  if (archived && archived.key === state.decisionModal?.key) return [{ ...archived, kind: 'decision', at: archived.askedAt }];
  // A direct decision link still opens its target, even with another repo selected.
  const key = state.decisionModal?.key;
  const view = viewOf(state);
  const target =
    key && view && !cards.some((c) => c.key === key)
      ? decisionCards(view.attention || [], view.decisions || [], view.dispatches).find((c) => c.key === key)
      : undefined;
  return openDecisionOrder(target ? [...cards, target] : cards, (k) => !!state.drafts[k]?.sent);
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
  if (!modalOrder().some((card) => card.key === target)) void loadClosedDecision(target);
}

/** Fetch a closed card only when its deep link is outside the live queue. */
async function loadClosedDecision(key: string): Promise<void> {
  try {
    const answer = await backend().decision(key);
    if (!answer.ok) return;
    const archivedDecision = answer.data;
    if (getState().decisionModal?.key === key) setState({ archivedDecision });
  } catch {
    /* The existing empty state remains when a card cannot be read. */
  }
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
  if (!c || (c.kind === 'decision' && c.readOnly) || n < 1 || n > HOTKEY_MAX) return false;
  if (c.kind === 'decision' && c.permissionsProposal) return false;
  const draft = getState().drafts[c.key];
  if (draft?.sending || draft?.sent) return false;
  const options = c.kind === 'decision' ? c.options : [];
  if (n <= options.length) {
    setDraft(c.key, { option: options[n - 1], error: undefined });
    document.querySelectorAll<HTMLElement>('.dmodal .dopt')[n - 1]?.focus();
    return true;
  }
  if (n === options.length + 1 && !(c.kind === 'decision' && c.permission)) {
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
  const token = state.snapshot?.focusToken;
  if (!token) return;
  try {
    await backend().request('decision-viewed', { key }, token);
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
    const r = await backend().dispatch(id);
    next = r.ok ? { data: r.data } : { error: r.status === 404 ? 'this dispatch is gone' : `the detail answered ${r.status}` };
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
    const r = await backend().stats();
    if (!r.ok) throw new Error(`/data/stats answered ${r.status}`);
    setState({ stats: r.data, statsError: null });
  } catch {
    setState({ statsError: 'stats could not be read' });
  } finally {
    statsInflight = false;
  }
}

let settingsInflight = false;

/** The Settings tab's values: masked by the server, and only read. */
export async function loadSettings(): Promise<void> {
  if (settingsInflight) return;
  settingsInflight = true;
  try {
    const r = await backend().settings();
    if (!r.ok) throw new Error(`/data/settings answered ${r.status}`);
    setState({ settings: r.data, settingsError: null });
  } catch {
    setState({ settingsError: 'Settings could not be read' });
  } finally {
    settingsInflight = false;
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
    const r = await backend().older(kind, older[kind].length, 50);
    if (!r.ok) throw new Error(`/data/older answered ${r.status}`);
    setState({ older: addOlder(getState().older, r.data), olderLoading: null });
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
  const card = currentCards().find((c) => c.key === key);
  const permission = card?.kind === 'decision' && card.permission;
  const text = permission ? '' : draft.text;
  const files = permission ? [] : draft.files;
  if (!draft.option && !text.trim() && files.length === 0) {
    setDraft(key, {
      error: permission ? 'Choose an answer.' : 'Choose an option, write an answer, or attach a file.',
    });
    return;
  }
  if (!token) {
    setDraft(key, { error: 'This page has no answer token; reload it.' });
    return;
  }
  setDraft(key, { sending: true, error: undefined });
  try {
    const response = await backend().request(
      'decision-answer',
      {
        key,
        ...(draft.option ? { option: draft.option } : {}),
        ...(text.trim() ? { text } : {}),
        files: files.map((f) => ({ name: f.name, data: f.data })),
      },
      token,
    );
    const result = response.body;
    if (!response.ok || !result.ok) {
      setDraft(key, { sending: false, error: result.reason ?? `The answer was refused (${response.status}).` });
      return;
    }
    const previous = modalOrder();
    setDraft(key, { sending: false, sent: answerSummary({ option: draft.option, text, files: files.length }) });
    // Answered in the modal: the next open decision loads, or the all-answered state.
    const open = getState().decisionModal;
    if (open?.key === key) setState({ decisionModal: nextOpen(previous, currentCards(), getState().drafts, key) });
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

/** Why an action can't run on a page viewed through another address. */
export const READ_ONLY_REASON = 'This glass is read-only from here';

/** Ask the local server to focus one live trap; it accepts no path, URL, or command. */
export async function openTrapWindow(trapId: string): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) return;
  try {
    const result = (await backend().focus(trapId, token)).body;
    setState({ focusResults: { ...getState().focusResults, [trapId]: result.message ?? result.reason ?? 'Window focus failed' } });
  } catch {
    setState({ focusResults: { ...getState().focusResults, [trapId]: 'Window focus failed' } });
  }
}

/**
 * Ask the helm for a new trap: the server writes a trap-request and runs
 * nothing. Resolves to an error reason, or undefined on success; a fresh
 * snapshot follows at once so the requested card shows.
 */
export async function requestTrap(repo: string, harness: string): Promise<string | undefined> {
  const snapshot = getState().snapshot;
  const token = snapshot?.focusToken;
  if (!token) return snapshot?.viewer?.onMachine === false ? READ_ONLY_REASON : 'The glass has no page token yet.';
  try {
    const result = (await backend().request('trap-request', { repo, harness }, token)).body;
    if (!result.ok) return result.reason ?? 'The request was refused.';
  } catch {
    return 'The request could not be sent.';
  }
  try {
    receive(await backend().snapshot());
  } catch {
    // the next poll shows it
  }
  return undefined;
}

export type ReviewRequestKind =
  | 'grant-revoke'
  | 'review-seen'
  | 'review-skip'
  | 'review-approve'
  | 'review-request-changes'
  | 'review-comment'
  | 'review-dismiss'
  | 'review-redraft'
  | 'review-draft'
  | 'review-mode';

/**
 * A Reviews-tab action (Dismiss, Re-draft): one same-origin POST
 * to /requests with the page's token. Resolves to an error reason, or
 * undefined on success; a fresh snapshot follows at once.
 */
export async function reviewRequest(kind: ReviewRequestKind, payload: Record<string, unknown>): Promise<string | undefined> {
  // A source without review actions shows none; a view it records (review-seen) is skipped.
  if (!can('review-request')) return 'Reviews are read-only here.';
  return glassRequest(kind, payload);
}

/** Set or move a todo's time from its row. Resolves to the parser's message, or undefined on success. */
export async function scheduleTodo(grounds: string, id: number, until: string): Promise<string | undefined> {
  return glassRequest('todo-schedule', { grounds, id, until });
}

/** Queue a message for the helm about a job. Resolves to the refusal, or undefined once it is queued. */
export async function messageHelm(dispatch: string, text: string): Promise<string | undefined> {
  return glassRequest('message', { dispatch, text });
}

/** Cancel a job, fencing its worker. Resolves to the refusal, or undefined once it is cancelled. */
export async function cancelJob(dispatch: string): Promise<string | undefined> {
  return glassRequest('cancel', { dispatch });
}

/** Ask the boat that drafted a review to dismiss it (and its pending draft). */
export async function dismissReview(key: string): Promise<string | undefined> {
  return glassRequest('review-dismiss', { key });
}

export async function changeHelmChat(grounds: string, chat: 'full' | 'brief'): Promise<string | undefined> {
  return glassRequest('helm-chat', { grounds, chat });
}

async function glassRequest(kind: string, payload: Record<string, unknown>): Promise<string | undefined> {
  const snapshot = getState().snapshot;
  const token = snapshot?.focusToken;
  if (!token) return snapshot?.viewer?.onMachine === false ? READ_ONLY_REASON : 'The glass has no page token yet.';
  try {
    const result = (await backend().request(kind, payload, token)).body;
    if (!result.ok) return result.reason ?? 'The request was refused.';
  } catch {
    return 'The request could not be sent.';
  }
  try {
    receive(await backend().snapshot());
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

/** Acknowledge the PR/stack states one stack group showed, using the guarded request path. */
export async function ackPrAttention(items: Array<{ key: string; stateHash: string }>): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) throw new Error('Reload the glass before acknowledging.');
  const response = await backend().request<{
    ok: boolean;
    reason?: string;
    acked?: Array<{ key: string; stateHash: string; at: string; by: string }>;
  }>('pr-ack', { items: items.map(({ key, stateHash }) => ({ key, stateHash })) }, token);
  const result = response.body;
  if (!response.ok || !result.ok) throw new Error(result.reason ?? 'Could not acknowledge PRs.');
  const snapshot = getState().snapshot;
  if (snapshot)
    setState({
      snapshot: {
        ...snapshot,
        attention: snapshot.attention.map((a) => {
          const ack = result.acked?.find((i) => i.key === a.key && i.stateHash === a.stateHash);
          return ack ? { ...a, acked: { at: ack.at, by: ack.by } } : a;
        }),
      },
    });
}

/** A permissions proposal uses its own glass action; it never passes through generic decision answers. */
async function permissionsProposalRequest(
  kind: 'permissions-proposal-preview' | 'permissions-proposal-answer',
  payload: Record<string, unknown>,
): Promise<{ diff?: string; diffHash?: string }> {
  const token = getState().snapshot?.focusToken;
  if (!token) throw new Error('Reload this page before answering the proposal.');
  const response = await backend().request<{ ok?: boolean; reason?: string; diff?: string; diffHash?: string }>(kind, payload, token);
  const result = response.body;
  if (!response.ok || !result.ok) throw new Error(result.reason ?? 'The permission proposal request failed.');
  return result;
}

/** Unticking a rule requests a new exact preview; stale preview responses cannot replace a newer selection. */
export async function selectProposalRule(key: string, ruleId: string): Promise<void> {
  const card = modalOrder().find((decision) => decision.key === key);
  if (card?.kind !== 'decision' || !card.permissionsProposal) return;
  const current = getState().drafts[key]?.proposalSelection ?? card.permissionsProposal.rules.map((rule) => rule.id);
  const selected = current.includes(ruleId) ? current.filter((id) => id !== ruleId) : [...current, ruleId];
  setDraft(key, { proposalSelection: selected, proposalLoading: selected.length > 0, proposalDiffHash: undefined, error: undefined });
  if (!selected.length) return;
  try {
    const preview = await permissionsProposalRequest('permissions-proposal-preview', { key, selected });
    if (JSON.stringify(getState().drafts[key]?.proposalSelection) === JSON.stringify(selected))
      setDraft(key, { proposalDiff: preview.diff, proposalDiffHash: preview.diffHash, proposalLoading: false });
  } catch (error) {
    if (JSON.stringify(getState().drafts[key]?.proposalSelection) === JSON.stringify(selected))
      setDraft(key, { proposalLoading: false, error: error instanceof Error ? error.message : 'The preview failed.' });
  }
}

/** Approve/reject through the dedicated person-facing glass route, then advance the existing decision queue. */
export async function sendPermissionsProposal(key: string, option: 'Approve' | 'Reject'): Promise<void> {
  const card = modalOrder().find((decision) => decision.key === key);
  if (card?.kind !== 'decision' || !card.permissionsProposal) return;
  const draft = getState().drafts[key];
  if (draft?.sending || draft?.proposalLoading) return;
  const selected = draft?.proposalSelection ?? card.permissionsProposal.rules.map((rule) => rule.id);
  const diffHash = draft?.proposalDiffHash ?? (draft?.proposalSelection ? undefined : card.permissionsProposal.diffHash);
  if (option === 'Approve' && (!selected.length || !diffHash)) return;
  setDraft(key, { sending: true, error: undefined });
  try {
    await permissionsProposalRequest('permissions-proposal-answer', { key, option, selected, diffHash });
    const previous = modalOrder();
    setDraft(key, { sending: false, sent: option === 'Approve' ? 'Permission changes applied' : 'Permission changes rejected' });
    if (getState().decisionModal?.key === key) setState({ decisionModal: nextOpen(previous, currentCards(), getState().drafts, key) });
  } catch (error) {
    setDraft(key, { sending: false, error: error instanceof Error ? error.message : 'The proposal could not be answered.' });
  }
}

/** Where passkeys work: the glass at localhost on this port (WebAuthn can't use an IP address). */
export function runPasskeyUrl(hash = ''): string {
  return `http://localhost${location.port ? ':' + location.port : ''}/${hash}`;
}

/** This page can hold a passkey ceremony: it is the localhost glass, in a browser with WebAuthn. */
export function passkeysWorkHere(): boolean {
  return (
    location.hostname === 'localhost' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof PublicKeyCredential !== 'undefined'
  );
}

const b64url = (buf: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const text = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
};

/**
 * Register this Mac's passkey for run cards: the server issues a challenge,
 * the browser creates an ES256 passkey for `localhost` with user
 * verification, and the server checks it and asks Chris outside the browser
 * before storing its public key.
 */
export async function registerRunPasskey(): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) return setState({ runPasskey: { error: 'This page has no token; reload it.' } });
  setState({ runPasskey: { busy: true } });
  try {
    const start = (
      await backend().request<{
        ok: boolean;
        reason?: string;
        challenge?: string;
        rpId?: string;
        existingChallenge?: string;
        credentialIds?: string[];
      }>('run-passkey-challenge', {}, token)
    ).body;
    if (!start.ok || !start.challenge) return setState({ runPasskey: { error: start.reason ?? 'The glass refused to start.' } });
    // A passkey already registered confirms the new one first.
    let existing: Record<string, string> | undefined;
    if (start.existingChallenge) {
      const got = (await navigator.credentials.get({
        publicKey: {
          challenge: fromB64url(start.existingChallenge),
          rpId: start.rpId ?? 'localhost',
          allowCredentials: (start.credentialIds ?? []).map((id) => ({ type: 'public-key' as const, id: fromB64url(id) })),
          userVerification: 'required',
          timeout: 120_000,
        },
      })) as PublicKeyCredential | null;
      if (!got) return setState({ runPasskey: { error: 'Your current passkey did not confirm.' } });
      const r = got.response as AuthenticatorAssertionResponse;
      existing = {
        credentialId: b64url(got.rawId),
        clientDataJSON: b64url(r.clientDataJSON),
        authenticatorData: b64url(r.authenticatorData),
        signature: b64url(r.signature),
      };
    }
    const created = (await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(start.challenge),
        rp: { id: start.rpId ?? 'localhost', name: 'lobstah glass' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'run cards', displayName: 'lobstah run cards' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
    if (!created) return setState({ runPasskey: { error: 'No passkey was created.' } });
    const response = created.response as AuthenticatorAttestationResponse;
    const publicKey = response.getPublicKey();
    if (!publicKey) return setState({ runPasskey: { error: 'This browser did not give the passkey’s public key.' } });
    const done = (
      await backend().request<{ ok: boolean; reason?: string }>(
        'run-passkey-register',
        {
          credentialId: b64url(created.rawId),
          clientDataJSON: b64url(response.clientDataJSON),
          authenticatorData: b64url(response.getAuthenticatorData()),
          publicKey: b64url(publicKey),
          alg: response.getPublicKeyAlgorithm(),
          ...(existing ? { existing } : {}),
        },
        token,
      )
    ).body;
    setState({
      runPasskey: done.ok ? { done: 'Passkey registered for run cards.' } : { error: done.reason ?? 'The passkey was not registered.' },
    });
    // The count in Settings and the cards' Run follow at once, not at the next poll.
    if (done.ok) receive(await backend().snapshot());
  } catch (err) {
    setState({ runPasskey: { error: err instanceof Error ? err.message : 'The passkey was not registered.' } });
  }
}

const setRun = (key: string, patch: Partial<import('./store.js').RunView>) => {
  const runs = getState().runs ?? {};
  const current = runs[key] ?? { busy: false, output: '', next: 0 };
  setState({ runs: { ...runs, [key]: { ...current, ...patch } } });
};

/**
 * Run a run card: ask the server for a challenge bound to this card and the
 * script hash this page shows, confirm it with the passkey (Touch ID), send
 * the assertion with the typed inputs, then follow the scrubbed output until
 * the run ends. The inputs go in that one request and are kept nowhere here.
 */
export async function runRunCard(key: string, sha256: string, inputs: Record<string, string>): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) return setRun(key, { error: 'This page has no token; reload it.' });
  const card = currentCards().find((c) => c.key === key);
  setRun(key, { busy: true, error: undefined, output: '', next: 0, result: undefined, ...(card ? { card } : {}) });
  try {
    const start = (
      await backend().request<{ ok: boolean; reason?: string; challenge?: string; rpId?: string; credentialIds?: string[] }>(
        'run-challenge',
        { key, sha256 },
        token,
      )
    ).body;
    if (!start.ok || !start.challenge) return setRun(key, { busy: false, error: start.reason ?? 'The glass refused the run.' });
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64url(start.challenge),
        rpId: start.rpId ?? 'localhost',
        allowCredentials: (start.credentialIds ?? []).map((id) => ({ type: 'public-key' as const, id: fromB64url(id) })),
        userVerification: 'required',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
    if (!got) return setRun(key, { busy: false, error: 'The passkey was not used.' });
    const response = got.response as AuthenticatorAssertionResponse;
    const started = (
      await backend().request<{ ok: boolean; reason?: string }>(
        'run',
        {
          key,
          credentialId: b64url(got.rawId),
          clientDataJSON: b64url(response.clientDataJSON),
          authenticatorData: b64url(response.authenticatorData),
          signature: b64url(response.signature),
          inputs,
        },
        token,
      )
    ).body;
    if (!started.ok) return setRun(key, { busy: false, error: started.reason ?? 'The run did not start.' });
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const after = getState().runs?.[key]?.next ?? 0;
      const page = (
        await backend().request<{
          ok: boolean;
          reason?: string;
          text?: string;
          next?: number;
          result?: import('./store.js').RunView['result'];
        }>('run-output', { key, after }, token)
      ).body;
      if (!page.ok) return setRun(key, { busy: false, error: page.reason ?? 'The run’s output stopped.' });
      setRun(key, { output: (getState().runs?.[key]?.output ?? '') + (page.text ?? ''), next: page.next ?? after });
      if (page.result) return setRun(key, { busy: false, result: page.result });
    }
  } catch (err) {
    setRun(key, { busy: false, error: err instanceof Error ? err.message : 'The run did not start.' });
  }
}
