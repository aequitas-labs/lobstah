import { loadSettings, loadStats, markStale, receive, receiveBeats, refreshDetail } from './actions.js';
import { getState } from './store.js';
import { sendPresence } from './presence.js';
import { backend } from './backend.js';

/**
 * Polling: /data every 2s, one request at a time, and not at all while the
 * tab is hidden. Each poll sends the last ETag: a 304 means nothing a person
 * reads changed, and only its beats (server time, heartbeats) apply. Each
 * snapshot goes to the store; rendering is Preact's. An open dispatch modal
 * refreshes its detail after every poll, and an open Stats tab its numbers
 * (/data/stats). Every poll also reports this page's
 * presence (presence.ts).
 */

let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;
let etag: string | null = null;

export async function poll(): Promise<void> {
  if (inflight) return;
  inflight = true;
  void sendPresence();
  try {
    let answer = await backend().poll(etag);
    // An unchanged answer that carried no beats: read the whole snapshot, without the ETag.
    if (answer.kind === 'unchanged' && !answer.beats) {
      etag = null;
      answer = await backend().poll(null);
    }
    if (answer.kind === 'unchanged') receiveBeats(answer.beats!);
    else {
      etag = answer.etag;
      receive(answer.snapshot);
    }
    void refreshDetail();
    if (getState().route === 'stats') void loadStats();
    if (getState().route === 'settings') void loadSettings();
  } catch (e) {
    markStale();
  } finally {
    inflight = false;
  }
}

const startPoll = () => {
  if (!timer) timer = setInterval(poll, 2000);
};
const stopPoll = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/** First fetch now; poll while the tab is visible, pause while hidden. */
export function startPolling(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else {
      poll();
      startPoll();
    }
  });
  poll();
  if (!document.hidden) startPoll();
}
