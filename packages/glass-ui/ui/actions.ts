import type { GlassSettings } from '@lobstah/core';
import type { GlassBeats, GlassDispatch, GlassOlderKind, GlassOlderPage, GlassSnapshot, StatsPage } from '@lobstah/core';
import {
  addOlder,
  answerSummary,
  applyBeats,
  decisionCards,
  decisionNeighbours,
  filteredDecisionCards,
  modalItem,
  prHash,
  prFromHash,
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
import { RUN_LINE_SEAL_INFO, RUN_SEAL_INFO, runInputsText, runLineSignedText } from '../../core/src/run-inputs.js';
import type { RunInputValues, SealedInput } from '../../core/src/run-inputs.js';

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
/** Previous or next from the decision on screen, including a finished run card the snapshot no longer lists. */
export function stepDecision(dir: -1 | 1): void {
  const state = getState();
  const open = state.decisionModal;
  if (!open?.key) return;
  const order = modalOrder();
  const shown = order.find((c) => c.key === open.key) ?? state.runs?.[open.key]?.card;
  if (!shown) return;
  const near = decisionNeighbours(order, shown);
  const next = dir < 0 ? near.prev : near.next;
  if (next) setState({ decisionModal: { key: next.key } });
}

export const closeDecision = (): void => setState({ decisionModal: null });

/** Hotkeys reach the first nine answers only: 1–9. */
export const HOTKEY_MAX = 9;

/** Whether this page pushed the open report's history entry, so Back can return to the entry before it. */
let reportPushed = false;
/** Where the page was scrolled when the sheet opened, to put it back on close: going back to `#deck` would jump to the tab's top. */
let reportScroll: number | undefined;

/**
 * Open a report in the sheet over the glass: a `#report/<key>` hash, a new
 * history entry, so the browser's back button and the phone's back gesture
 * close it. The tab underneath keeps its place and scroll.
 */
export function openReportSheet(key: string): void {
  reportPushed = true;
  reportScroll = window.scrollY;
  location.hash = '#report/' + encodeURIComponent(key);
}

/** The hash named a report, or stopped naming one (start.ts onRoute). */
export function routeReport(key: string | null): void {
  const closing = key === null && !!getState().reportSheet;
  if (key === null) reportPushed = false;
  if ((getState().reportSheet ?? null) !== key) setState({ reportSheet: key });
  if (closing && reportScroll !== undefined) {
    const y = reportScroll;
    reportScroll = undefined;
    // After the browser's own jump to the tab's anchor.
    setTimeout(() => window.scrollTo(0, y), 0);
  }
}

/**
 * Close the sheet: back to the entry this page pushed, or, for a sheet a
 * link opened, replace its hash with the tab's so nothing leaves the glass.
 */
export function closeReportSheet(): void {
  if (!getState().reportSheet) return;
  if (reportPushed) {
    reportPushed = false;
    history.back();
    return;
  }
  history.replaceState(null, '', '#' + getState().route);
  routeReport(null);
}

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

/** The dispatch whose detail is being read: one read at a time, so a slow source never stacks them. */
let detailInflight: string | null = null;

/** What a failed detail read says; the next poll reads again. */
function detailError(status: number): string {
  if (status === 404) return 'this dispatch is gone';
  if (status === 429) return 'Busy right now. Retrying…';
  if (status === 504) return "The boat didn't answer yet. Retrying…";
  return `the detail answered ${status}`;
}

/** Fetch the open dispatch modal's detail; a later modal or a newer answer wins. A read already in flight for it is not repeated. */
export async function refreshDetail(): Promise<void> {
  const { modal } = getState();
  if (modal?.type !== 'dispatch') return;
  const key = modal.key;
  if (detailInflight === key) return;
  detailInflight = key;
  const id = key.slice(key.indexOf(':') + 1);
  let next: { data?: GlassDispatch; error?: string };
  try {
    const r = await backend().dispatch(id);
    next = r.ok ? { data: r.data } : { error: detailError(r.status) };
  } catch {
    next = { error: 'the detail could not be read' };
  } finally {
    if (detailInflight === key) detailInflight = null;
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
    setState({ settingsError: 'Configuration could not be read' });
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
export async function sendAnswer(key: string): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  const draft = getState().drafts[key] ?? emptyDraft();
  if (draft.sending || draft.sent) return;
  const card = currentCards().find((c) => c.key === key);
  const permission = card?.kind === 'decision' && card.permission;
  const text = permission ? '' : draft.text;
  const files = permission ? [] : draft.files;
  if (!draft.option && !text.trim() && files.length === 0) {
    const error = permission ? 'Choose an answer.' : 'Choose an option, write an answer, or attach a file.';
    setDraft(key, { error });
    return error;
  }
  if (!token) {
    const error = 'Reload the page to answer.';
    setDraft(key, { error });
    return error;
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
      const error = result.reason ?? "Your answer didn't go through. Reload and try again.";
      setDraft(key, { sending: false, error });
      return error;
    }
    const previous = modalOrder();
    setDraft(key, { sending: false, sent: answerSummary({ option: draft.option, text, files: files.length }) });
    // Answered in the modal: the next open decision loads, or the all-answered state.
    const open = getState().decisionModal;
    if (open?.key === key) setState({ decisionModal: nextOpen(previous, currentCards(), getState().drafts, key) });
    return undefined;
  } catch {
    const error = 'The answer could not be sent.';
    setDraft(key, { sending: false, error });
    return error;
  }
}

export const markStale = (): void => setState({ stale: true });

/** Show an image in the in-page overlay. */
export const openLightbox = (src: string, name: string, origin?: Element): void => {
  const selector = '.mdimg img, .thumb img, .dimg img';
  const thumbnails = [...document.querySelectorAll<HTMLImageElement>(selector)];
  const image = origin?.querySelector<HTMLImageElement>('img') ?? thumbnails.find((image) => image.getAttribute('src') === src);
  const container =
    image?.closest('.github-description, .reportview, .rsheet, .dmodal, .drow, .card, .detail-scroll, #modalbox') ?? image?.closest('.md');
  const images = container
    ? [...container.querySelectorAll<HTMLImageElement>(selector)].map((image) => ({
        src: image.getAttribute('src')!,
        name: image.alt || image.getAttribute('src')!,
      }))
    : [{ src, name }];
  const index = images.findIndex((image) => image.src === src);
  setState({ lightbox: index >= 0 ? { src, name, images, index } : { src, name } });
};
/** Step only within the images of the card, report or description that opened the overlay. */
export const stepLightbox = (direction: -1 | 1): void => {
  const box = getState().lightbox;
  if (!box?.images || box.images.length < 2) return;
  const index = ((box.index ?? 0) + direction + box.images.length) % box.images.length;
  setState({ lightbox: { ...box, ...box.images[index]!, index } });
};
export const closeLightbox = (): void => setState({ lightbox: null });

let prPushed = false;
let prScroll: number | undefined;

/** Keep the tab and its scroll position under a PR route, including browser Back. */
export function routePrView(key: string | null): void {
  const modal = getState().modal;
  if (key) {
    if (modal?.type !== 'pr' || modal.key !== key) setState({ modal: { type: 'pr', key }, detail: null });
  } else if (modal?.type === 'pr') {
    prPushed = false;
    setState({ modal: null, detail: null });
    const y = prScroll;
    prScroll = undefined;
    if (y !== undefined) setTimeout(() => window.scrollTo(0, y), 0);
  }
}

/** Close a PR opened here through browser history, or keep a direct link inside the glass. */
function closePrView(): void {
  if (prPushed) {
    prPushed = false;
    history.back();
    return;
  }
  history.replaceState(null, '', '#' + getState().route);
  routePrView(null);
}

export function showModal(type: ModalType, key: string): void {
  const state = getState();
  if (type === 'review') {
    showModal('pr', key.replace('review:', 'pr:'));
    return;
  }
  if (type === 'pr') {
    if (!prFromHash(location.hash)) {
      prPushed = true;
      prScroll = window.scrollY;
    }
    location.hash = prHash(key);
    routePrView(key);
    return;
  }
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
  if (getState().modal?.type === 'pr') {
    closePrView();
    return;
  }
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
  | 'review-mute'
  | 'review-unmute'
  | 'review-redraft'
  | 'review-draft';

/**
 * A Reviews-tab action (Dismiss, Re-draft): one same-origin POST
 * to /requests with the page's token. Resolves to an error reason, or
 * undefined on success; a fresh snapshot follows at once.
 */
export async function reviewRequest(kind: ReviewRequestKind, payload: Record<string, unknown>): Promise<string | undefined> {
  // A source without review actions shows none; a view it records (review-seen) is skipped.
  if (!can('review-request') && !can('review-dismiss') && !can('review-mute') && !can('review-unmute'))
    return 'Reviews are read-only here.';
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

/** Mute every future review round for a PR. */
export async function muteReviewPr(key: string): Promise<string | undefined> {
  return glassRequest('review-mute', { key });
}

/** Resume review rounds for a muted PR. */
export async function unmuteReviewPr(key: string): Promise<string | undefined> {
  return glassRequest('review-unmute', { key });
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

/**
 * A clicked lob: hidden in this browser at once (deferred, so a PR lob's link
 * still follows), and acknowledged where its ack lives, so the pet and every
 * other glass stop walking it too. A new state re-shows it everywhere. A
 * source that cannot acknowledge, or an ack that fails, leaves the local hide.
 */
export function hideLob(key: string, hash: string): void {
  const lobHidden = { ...getState().lobHidden, [key]: hash };
  saveLobHidden(lobHidden);
  setTimeout(() => setState({ lobHidden }), 0);
  if (can('attention-ack')) void ackAttention('attention-ack', [{ key, stateHash: hash }]).catch(() => {});
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
export const ackPrAttention = (items: Array<{ key: string; stateHash: string }>): Promise<void> => ackAttention('pr-ack', items);

/**
 * Ask the boat to merge one of your PRs once it's green, or cancel that.
 * The snapshot shows the request from the next poll; this marks it at once.
 */
export async function requestPrMerge(key: string, cancel = false): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) throw new Error('Reload the glass before merging.');
  const response = await backend().request<{ ok: boolean; reason?: string; method?: 'merge' | 'squash' | 'rebase' }>(
    'pr-merge',
    { key, ...(cancel ? { cancel: true } : {}) },
    token,
  );
  const result = response.body;
  if (!response.ok || !result.ok)
    throw new Error(result.reason ?? (cancel ? 'Could not cancel the merge.' : 'Could not ask for the merge.'));
  const snapshot = getState().snapshot;
  if (snapshot) {
    const at = new Date().toISOString();
    setState({
      snapshot: {
        ...snapshot,
        prs: snapshot.prs.map((p) => {
          if (p.key !== key) return p;
          if (cancel) {
            const { mergeRequest: _gone, ...rest } = p;
            return rest;
          }
          return { ...p, mergeRequest: { at, method: result.method ?? 'squash' } };
        }),
      },
    });
  }
}

/**
 * Ask the boat to merge a whole stack of your PRs once every one is green,
 * or cancel that. The snapshot shows the request from the next poll; this
 * marks it at once.
 */
export async function requestStackMerge(stack: string, cancel = false): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) throw new Error('Reload the glass before merging.');
  const response = await backend().request<{ ok: boolean; reason?: string; method?: 'merge' | 'squash' | 'rebase' }>(
    'stack-merge',
    { stack, ...(cancel ? { cancel: true } : {}) },
    token,
  );
  const result = response.body;
  if (!response.ok || !result.ok)
    throw new Error(result.reason ?? (cancel ? 'Could not cancel the merge.' : 'Could not ask for the merge.'));
  const snapshot = getState().snapshot;
  if (snapshot) {
    const at = new Date().toISOString();
    setState({
      snapshot: {
        ...snapshot,
        stacks: snapshot.stacks.map((s) => {
          if (s.id !== stack) return s;
          if (cancel) {
            const { mergeRequest: _gone, ...rest } = s;
            return rest;
          }
          return { ...s, mergeRequest: { at, method: result.method ?? 'squash' } };
        }),
      },
    });
  }
}

/** Acknowledge the attention states this page showed, and mark them acked in the snapshot it holds. */
async function ackAttention(kind: 'pr-ack' | 'attention-ack', items: Array<{ key: string; stateHash: string }>): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token) throw new Error('Reload the glass before acknowledging.');
  const response = await backend().request<{
    ok: boolean;
    reason?: string;
    acked?: Array<{ key: string; stateHash: string; at: string; by: string }>;
  }>(kind, { items: items.map(({ key, stateHash }) => ({ key, stateHash })) }, token);
  const result = response.body;
  if (!response.ok || !result.ok)
    throw new Error(result.reason ?? (kind === 'pr-ack' ? 'Could not acknowledge PRs.' : 'Could not acknowledge this.'));
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
export async function sendPermissionsProposal(key: string, option: 'Approve' | 'Reject'): Promise<string | undefined> {
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
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The proposal could not be answered.';
    setDraft(key, { sending: false, error: message });
    return message;
  }
}

/** Where passkeys work: the glass at localhost on this port (WebAuthn can't use an IP address). */
export function runPasskeyUrl(hash = ''): string {
  return `http://localhost${location.port ? ':' + location.port : ''}/${hash}`;
}

/**
 * This page can hold a passkey ceremony: a browser with WebAuthn, at
 * localhost for the Mac's own passkey, or anywhere for a phone's on the
 * hosted glass (its passkey is for the hosted glass's own host).
 */
export function passkeysWorkHere(hosted = false): boolean {
  return (
    (hosted || location.hostname === 'localhost') &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof PublicKeyCredential !== 'undefined'
  );
}

/**
 * The page's 15-minute windows, by boat (the local glass's is ''): a P-256
 * key made at a passkey confirmation, whose private half can't be exported
 * and lives only in this module's memory. The boat binds the window to its
 * public half. A reload, another tab or another device has none.
 */
const runWindows = new Map<string, { key: CryptoKeyPair; id: string; until: number }>();

/**
 * The page key that started each hosted run, by card key, and the next line's
 * number: the boat takes a line into that run only signed with this key. A
 * reload, another tab or another device has none.
 */
const runLineKeys = new Map<string, { key: CryptoKey; seq: number }>();

/** Minutes left in this page's window for a boat, or 0. */
export function runWindowMinutes(boat = ''): number {
  const w = runWindows.get(boat);
  return w && w.until > Date.now() ? Math.ceil((w.until - Date.now()) / 60_000) : 0;
}

/** The sha256 of a text, as hex: the script this page shows, or its inputs as sent. */
async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seal one secret to the boat's key: ECDH between a fresh P-256 key and the
 * boat's, HKDF-SHA256, AES-256-GCM. Only the boat's private key opens it; the
 * fresh key's private half is dropped here.
 */
async function sealInput(value: string, boatKey: string, info = RUN_SEAL_INFO): Promise<SealedInput> {
  const boat = await crypto.subtle.importKey('spki', fromB64url(boatKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: boat }, mine.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(value));
  return { epk: b64url(await crypto.subtle.exportKey('spki', mine.publicKey)), iv: b64url(iv.buffer), ct: b64url(ct) };
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
export async function runRunCard(key: string, sha256: string, inputs: Record<string, string>): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return runFailure(key, 'Reload the page to run this card.');
  const card = currentCards().find((c) => c.key === key);
  setRun(key, { busy: true, error: undefined, output: '', next: 0, result: undefined, id: undefined, ...(card ? { card } : {}) });
  const run = card?.kind === 'decision' ? card.run : undefined;
  const boat = run?.boat ?? '';
  runLineKeys.delete(key);
  try {
    // On the hosted glass each secret is sealed to the boat's key here, so the wharf only ever relays sealed values.
    const sent: RunInputValues = {};
    for (const input of run?.inputs ?? []) {
      const value = inputs[input.name];
      if (value === undefined) continue;
      if (run?.boat !== undefined && input.secret) {
        if (!run.sealKey) return runFailure(key, 'Secret inputs are typed on the Mac for now.');
        sent[input.name] = await sealInput(value, run.sealKey);
      } else sent[input.name] = value;
    }
    // The challenge binds the inputs by hash, so the boat runs only with the ones confirmed here.
    const inputsSha256 = await sha256Text(runInputsText(sent));
    const open = runWindows.get(boat);
    const inWindow = open && open.until > Date.now() ? open : undefined;
    const start = (
      await backend().request<{
        ok: boolean;
        reason?: string;
        challenge?: string;
        rpId?: string;
        credentialIds?: string[];
        sha256?: string;
        window?: string;
      }>('run-challenge', { key, sha256, inputsSha256, ...(inWindow ? { window: inWindow.id } : {}) }, token)
    ).body;
    if (!start.ok || !start.challenge) return runFailure(key, start.reason ?? 'The glass refused the run.');
    // The script this page shows must be the one the boat will run: never ask for a passkey over another.
    if (!run || (await sha256Text(run.script)) !== (start.sha256 ?? sha256) || sha256 !== (start.sha256 ?? sha256))
      return runFailure(key, "The script this page shows isn't the card's. Reload the page.");
    if (start.window && inWindow) {
      // Inside the window: the page's window key signs the boat's fresh challenge instead of a passkey.
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        inWindow.key.privateKey,
        new TextEncoder().encode(start.challenge),
      );
      const started = (
        await backend().request<{ ok: boolean; reason?: string }>(
          'run',
          { key, challenge: start.challenge, window: inWindow.id, windowSignature: b64url(signature), inputs: sent },
          token,
        )
      ).body;
      if (!started.ok) return runFailure(key, started.reason ?? 'The run did not start.');
      if (run.boat !== undefined) runLineKeys.set(key, { key: inWindow.key.privateKey, seq: 0 });
      void followRunCard(key);
      return undefined;
    }
    runWindows.delete(boat);
    // A new window key for this confirmation: its private half never leaves this page.
    const windowKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const windowPublic = b64url(await crypto.subtle.exportKey('spki', windowKey.publicKey));
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64url(start.challenge),
        rpId: start.rpId ?? 'localhost',
        allowCredentials: (start.credentialIds ?? []).map((id) => ({ type: 'public-key' as const, id: fromB64url(id) })),
        userVerification: 'required',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
    if (!got) return runFailure(key, 'The passkey was not used.');
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
          inputs: sent,
          windowKey: windowPublic,
        },
        token,
      )
    ).body as { ok: boolean; reason?: string; window?: string; windowUntil?: number };
    if (!started.ok) return runFailure(key, started.reason ?? 'The run did not start.');
    if (started.window && started.windowUntil) runWindows.set(boat, { key: windowKey, id: started.window, until: started.windowUntil });
    if (run.boat !== undefined) runLineKeys.set(key, { key: windowKey.privateKey, seq: 0 });
    void followRunCard(key);
    return undefined;
  } catch (err) {
    return runFailure(key, err instanceof Error ? err.message : 'The run did not start.');
  }
}

/** Store a run-start refusal and return it so the action button can announce it beside the control. */
function runFailure(key: string, error: string): string {
  setRun(key, { busy: false, error });
  return error;
}

const runPollers = new Set<string>();

/** Reconnect a card to its persisted attempt, including after a page reload. */
export async function followRunCard(key: string): Promise<void> {
  const token = getState().snapshot?.focusToken;
  if (!token || runPollers.has(key)) return;
  runPollers.add(key);
  try {
    for (;;) {
      const current = getState().runs?.[key];
      const page = (
        await backend().request<{
          ok: boolean;
          reason?: string;
          warning?: string;
          text?: string;
          next?: number;
          id?: string;
          state?: import('@lobstah/core').RunState;
          startedAt?: string;
          finishedAt?: string;
          result?: import('@lobstah/core').RunResult;
        }>('run-output', { key, after: current?.next ?? 0, id: current?.id }, token)
      ).body;
      if (!page.ok) return setRun(key, { busy: false, error: page.reason ?? 'The output could not be loaded. Reload the card.' });
      const output = (current?.id && current.id !== page.id ? '' : (current?.output ?? '')) + (page.text ?? '');
      setRun(key, {
        id: page.id,
        state: page.state,
        startedAt: page.startedAt,
        finishedAt: page.finishedAt,
        busy: !page.result,
        result: page.result,
        error: page.warning,
        output: page.result
          ? output
              .split('\n')
              .slice(-201)
              .join('\n')
              .slice(-256 * 1024)
          : output.slice(-256 * 1024),
        next: page.next ?? 0,
      });
      if (page.result) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } catch {
    setRun(key, { busy: false, error: 'The output could not be loaded. Reload the card.' });
  } finally {
    runPollers.delete(key);
  }
}

/** Ask the local server to stop the card's complete process group. */
export async function stopRunCard(key: string): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return 'The command could not be stopped. Try again.';
  try {
    const response = (await backend().request<{ ok: boolean; reason?: string }>('run-stop', { key }, token)).body;
    if (!response.ok) {
      const error = response.reason ?? 'The command could not be stopped. Try again.';
      setRun(key, { error });
      return error;
    }
    return undefined;
  } catch {
    const error = 'The command could not be stopped. Try again.';
    setRun(key, { error });
    return error;
  }
}

/** Archive a finished card and retain the old queue slot. */
export async function dismissRunCard(key: string): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return 'The card could not be dismissed. Try again.';
  try {
    const response = (await backend().request<{ ok: boolean; reason?: string }>('run-dismiss', { key }, token)).body;
    if (!response.ok) {
      const error = response.reason ?? 'The card could not be dismissed. Try again.';
      setRun(key, { error });
      return error;
    }
    const previous = modalOrder();
    setDraft(key, { sent: 'Dismissed' });
    if (getState().decisionModal?.key === key) setState({ decisionModal: nextOpen(previous, currentCards(), getState().drafts, key) });
    return undefined;
  } catch {
    const error = 'The card could not be dismissed. Try again.';
    setRun(key, { error });
    return error;
  }
}

/** Send one line to a card's running interactive script; a secret line is scrubbed like an input. Resolves to why it failed, if it did. */
export async function sendRunLine(key: string, line: string, secret: boolean): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return 'This page has no token; reload it.';
  const card = currentCards().find((c) => c.key === key);
  const run = card?.kind === 'decision' ? card.run : undefined;
  // On the hosted glass the line is sealed to the boat and signed with the page key that started the run, so the wharf can't read, forge or replay it.
  const mine = run?.boat !== undefined ? runLineKeys.get(key) : undefined;
  try {
    let body: Record<string, unknown> = { key, line, secret };
    if (run?.boat !== undefined) {
      const attempt = getState().runs?.[key]?.id;
      if (!mine || !attempt) return 'Only the page that started this run can type into it. Type on the Mac, or Stop and run again.';
      if (!run.sealKey) return 'This boat takes no sealed lines. Type on the Mac.';
      const sealed = await sealInput(line, run.sealKey, RUN_LINE_SEAL_INFO);
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        mine.key,
        new TextEncoder().encode(runLineSignedText(key, attempt, mine.seq, secret, sealed)),
      );
      body = { key, attempt, seq: mine.seq, secret, sealed, signature: b64url(signature) };
    }
    const res = (await backend().request<{ ok: boolean; reason?: string }>('run-line', body, token)).body;
    if (res.ok && mine) mine.seq += 1;
    return res.ok ? undefined : (res.reason ?? 'The line was not sent.');
  } catch {
    return 'The line was not sent.';
  }
}
