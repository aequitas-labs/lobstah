import type { GlassSnapshot } from '@lobstah/core';
import { markStale, receive } from './actions.js';

/**
 * Polling: /data every 2s, one request at a time, and not at all while the
 * tab is hidden. Each snapshot goes to the store; rendering is Preact's.
 */

let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

export async function poll(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const r = await fetch('/data');
    receive((await r.json()) as GlassSnapshot);
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
