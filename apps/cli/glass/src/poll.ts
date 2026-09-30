import type { GlassBeats, GlassSnapshot } from '@lobstah/core';
import { markStale, receive, receiveBeats, refreshDetail } from './actions.js';

/**
 * Polling: /data every 2s, one request at a time, and not at all while the
 * tab is hidden. Each poll sends the last ETag: a 304 means nothing a person
 * reads changed, and only its beats (server time, heartbeats) apply. Each
 * snapshot goes to the store; rendering is Preact's. An open dispatch modal
 * refreshes its detail after every poll.
 */

let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;
let etag: string | null = null;

function beatsOf(r: Response): GlassBeats | undefined {
  const raw = r.headers?.get('x-lobstah-beats');
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw)) as GlassBeats;
  } catch {
    return undefined;
  }
}

export async function poll(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const r = await fetch('/data', { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} });
    if (r.status === 304) {
      const beats = beatsOf(r);
      if (beats) receiveBeats(beats);
      else receive(await refetch());
    } else {
      if (!r.ok) throw new Error(`/data answered ${r.status}`);
      etag = r.headers?.get('etag') ?? null;
      receive((await r.json()) as GlassSnapshot);
    }
    void refreshDetail();
  } catch (e) {
    markStale();
  } finally {
    inflight = false;
  }
}

/** A whole body, without the ETag: a 304 that carried no beats. */
async function refetch(): Promise<GlassSnapshot> {
  etag = null;
  const r = await fetch('/data', { cache: 'no-store' });
  if (!r.ok) throw new Error(`/data answered ${r.status}`);
  etag = r.headers?.get('etag') ?? null;
  return (await r.json()) as GlassSnapshot;
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
