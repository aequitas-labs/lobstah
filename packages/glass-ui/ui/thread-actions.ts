import type { ThreadView } from '@lobstah/core';
import { backend } from './backend.js';
import { getState, setState } from './store.js';
import { receive, setDraft } from './actions.js';

export function openMessage(about?: string, grounds?: string): void {
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
