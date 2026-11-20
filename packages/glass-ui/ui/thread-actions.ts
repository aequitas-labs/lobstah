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
export function openThread(id: string): void {
  location.hash = `#thread/${encodeURIComponent(id)}`;
}
export function threadId(): string | undefined {
  const match = /^#thread\/([0-9a-f-]{36})$/.exec(location.hash);
  return match?.[1];
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
