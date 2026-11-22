import type { ThreadView } from '@lobstah/core';
import { backend } from './backend.js';
import { getState, setState } from './store.js';
import type { PendingMessage } from './store.js';
import { receive, setDraft, toastTitle } from './actions.js';
import { newSubmissionId, submissionFingerprint, submit, takesSubmissions } from './submissions.js';
import { showToast } from './components/toast.js';

/** Message the helm: a dispatch with an unresolved thread opens that thread, ready to type in. */
export function openMessage(about?: string, grounds?: string): void {
  const existing = about ? getState().snapshot?.threads?.find((t) => t.about === about && t.state !== 'resolved') : undefined;
  if (existing) {
    setState({ focusComposer: existing.id });
    openThread(existing.id);
    return;
  }
  setState({ messageSheet: { about, grounds } });
}
export function closeMessage(): void {
  setState({ messageSheet: undefined });
}
/** Whether this page pushed the open conversation's history entry, so Back can return to the entry before it. */
let threadPushed = false;
/** Where the Threads list was scrolled when the sheet opened, to put it back on close. */
let threadScroll: number | undefined;
/**
 * Open a conversation in the sheet over the Threads tab, as a report opens:
 * a `#thread/<id>` hash and a new history entry, so the browser's back button
 * and the phone's back gesture close it.
 */
export function openThread(id: string): void {
  const hash = `#thread/${encodeURIComponent(id)}`;
  // Sending from the open conversation stays on its entry.
  if (location.hash === hash) return;
  threadPushed = true;
  threadScroll = window.scrollY;
  location.hash = hash;
}
/** The hash named a conversation, or stopped naming one (start.ts onRoute). */
export function routeThread(id: string | null): void {
  const closing = id === null && !!getState().threadSheet;
  if (id === null) threadPushed = false;
  if ((getState().threadSheet ?? null) !== id) setState({ threadSheet: id });
  if (closing && threadScroll !== undefined) {
    const y = threadScroll;
    threadScroll = undefined;
    // After the browser's own jump to the tab's anchor.
    setTimeout(() => window.scrollTo(0, y), 0);
  }
}
/**
 * Close the sheet: back to the entry this page pushed, or, for a sheet a
 * link opened, replace its hash with the Threads tab's.
 */
export function closeThreadSheet(): void {
  if (!getState().threadSheet) return;
  if (threadPushed) {
    threadPushed = false;
    history.back();
    return;
  }
  history.replaceState(null, '', '#helm');
  routeThread(null);
  setState({ route: 'helm' });
}
export async function sendMessage(key: string, target: { id?: string; grounds?: string; about?: string }): Promise<string | undefined> {
  const state = getState(),
    draft = state.drafts[key];
  if (draft?.sending) return;
  const fail = (error: string) => {
    setDraft(key, { sending: false, error });
    return error;
  };
  if (!draft || (!draft.text.trim() && !draft.files.length)) return fail('Write a message or attach a file');
  if (!state.snapshot?.focusToken) return fail('Reload the page to send');
  if (takesSubmissions()) {
    // The message shows in its conversation at once, and the composer is ready for the next one.
    // A message that came back from a failed send keeps its id while unchanged, so it is written once.
    const fingerprint = submissionFingerprint({ target, text: draft.text, files: draft.files.map((f) => f.name) });
    const submission = draft.submission && draft.submissionFor === fingerprint ? draft.submission : newSubmissionId();
    const message: PendingMessage = {
      submission,
      thread: target.id ?? submission,
      kind: target.id ? 'thread-post' : 'thread-start',
      target,
      draftKey: key,
      text: draft.text,
      files: draft.files,
      at: new Date().toISOString(),
      state: 'sending',
    };
    setState({ pendingMessages: [...(getState().pendingMessages ?? []), message] });
    setDraft(key, { text: '', files: [], sending: false, error: undefined, submission: undefined, submissionFor: undefined });
    if (!target.id) {
      // The new conversation replaces the sheet; its Back entry must not reopen it.
      if (history.state?.glassOverlay) {
        const { glassOverlay: _overlay, ...rest } = history.state;
        history.replaceState(rest, '', location.href);
      }
      closeMessage();
      openThread(message.thread);
    }
    void deliverMessage(message, state.snapshot.focusToken);
    return undefined;
  }
  setDraft(key, { sending: true, error: undefined });
  try {
    const response = await backend().request<{ ok?: boolean; reason?: string; item?: ThreadView }>(
      target.id ? 'thread-post' : 'thread-start',
      {
        ...target,
        text: draft.text,
        files: draft.files.map(({ name, data }) => ({ name, data })),
      },
      state.snapshot.focusToken,
    );
    if (!response.ok || !response.body.ok || !response.body.item) return fail(response.body.reason ?? 'The message could not be sent');
    setDraft(key, { text: '', files: [], sending: false, error: undefined });
    // The sent message replaces the sheet; its Back entry must not reopen it.
    if (history.state?.glassOverlay) {
      const { glassOverlay: _overlay, ...rest } = history.state;
      history.replaceState(rest, '', location.href);
    }
    closeMessage();
    openThread(response.body.item.id);
    // A saved message remains saved even if the following snapshot read fails.
    try {
      receive(await backend().snapshot());
    } catch {
      /* the next poll retries */
    }
    return undefined;
  } catch {
    return fail('The message could not be sent');
  }
}
/** The composer's note for a message that did not reach the helm, when the server gave no reason. */
export const MESSAGE_UNSENT = "Your message didn't go through. Try again.";

/** The toast for a message that did not reach the helm: where it was going, and that clicking opens it. */
export function messageUnsentToast(title: string | undefined): string {
  return title
    ? `Your message in “${toastTitle(title)}” didn't go through. Open it to try again.`
    : "Your message to the helm didn't go through. Open it to try again.";
}

/** Deliver a pending message, then show the conversation that holds it. A failed one goes back to its draft. */
async function deliverMessage(message: PendingMessage, token: string): Promise<void> {
  const payload = { ...message.target, text: message.text, files: message.files.map(({ name, data }) => ({ name, data })) };
  const outcome = await submit(message.kind, message.submission, payload, token, MESSAGE_UNSENT);
  if (outcome.state === 'failed') return unsent(message, outcome.reason, outcome.retrySame);
  setState({
    pendingMessages: (getState().pendingMessages ?? []).map((m) => (m.submission === message.submission ? { ...m, state: 'sent' } : m)),
  });
  // The conversation reloads once the snapshot names its new revision. A failed read leaves it to the next poll.
  try {
    receive(await backend().snapshot());
  } catch {
    /* the next poll retries */
  }
}

/**
 * A message that did not reach the helm leaves its conversation and goes
 * back to the composer it came from, with the reason, ahead of anything
 * typed since. A toast opens that conversation (or, for a new one, the
 * message dialog) to send it again. Sent again unchanged, it keeps its id
 * when it may have been recorded, so it is written once.
 */
function unsent(message: PendingMessage, reason: string, retrySame: boolean): void {
  setState({ pendingMessages: (getState().pendingMessages ?? []).filter((m) => m.submission !== message.submission) });
  const typed = getState().drafts[message.draftKey];
  const untouched = !typed || (!typed.text.trim() && typed.files.length === 0);
  const text = untouched ? message.text : [message.text, typed.text].filter((t) => t.trim()).join('\n\n');
  const files = untouched ? message.files : [...message.files, ...typed.files];
  const keep = untouched && retrySame;
  setDraft(message.draftKey, {
    text,
    files,
    error: reason,
    submission: keep ? message.submission : undefined,
    submissionFor: keep ? submissionFingerprint({ target: message.target, text, files: files.map((f) => f.name) }) : undefined,
  });
  // A new conversation was never written: its sheet has nothing to show.
  if (message.kind === 'thread-start' && getState().threadSheet === message.thread) closeThreadSheet();
  const title = message.kind === 'thread-post' ? getState().snapshot?.threads?.find((t) => t.id === message.thread)?.title : undefined;
  const grounds = message.draftKey.split(':')[1] || undefined;
  showToast(messageUnsentToast(title), {
    open: () => {
      if (message.kind === 'thread-start') return openMessage(message.target.about, message.target.grounds ?? grounds);
      setState({ focusComposer: message.thread });
      openThread(message.thread);
    },
  });
}

/** Drop pending messages the conversation now shows. */
export function settlePendingMessages(view: ThreadView): void {
  const pending = getState().pendingMessages ?? [];
  const shown = new Set(
    view.rounds.flatMap((round) =>
      round.entries.flatMap((entry) => ('by' in entry && entry.by === 'person' && entry.submission ? [entry.submission] : [])),
    ),
  );
  if (pending.some((m) => shown.has(m.submission))) setState({ pendingMessages: pending.filter((m) => !shown.has(m.submission)) });
}

export async function reopenConversation(id: string): Promise<string | undefined> {
  const token = getState().snapshot?.focusToken;
  if (!token) return 'Reload the page to reopen';
  try {
    const response = await backend().request('thread-reopen', { id }, token);
    if (!response.ok || !response.body.ok) return response.body.reason ?? 'The conversation could not be reopened';
    receive(await backend().snapshot());
  } catch {
    return 'The conversation could not be reopened';
  }
}

/** Acknowledge only the response sequence this page actually rendered. */
export async function markThreadResponseSeen(id: string, through: number): Promise<boolean> {
  const token = getState().snapshot?.focusToken;
  if (!token) return false;
  try {
    const response = await backend().request('thread-seen', { id, through }, token);
    if (response.ok && response.body.ok) {
      receive(await backend().snapshot());
      return true;
    }
  } catch {
    /* Keep the unread badge until a read is stored. */
  }
  return false;
}
