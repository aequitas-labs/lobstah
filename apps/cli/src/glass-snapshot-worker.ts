import { parentPort } from 'node:worker_threads';
import { buildGlassSnapshot } from './glass.js';

/**
 * The glass's snapshot thread. The server's own thread only answers HTTP;
 * this thread builds each /data body, so a page load or a focus click never
 * waits behind a snapshot. It lives as long as the server, which keeps its
 * git answers (liveness-view.ts) warm between polls.
 */
export interface SnapshotAsk {
  id: number;
  local: boolean;
}
export type SnapshotReply = { id: number; body: string } | { id: number; error: string };

parentPort?.on('message', (ask: SnapshotAsk) => {
  let reply: SnapshotReply;
  try {
    reply = { id: ask.id, body: JSON.stringify(buildGlassSnapshot({ local: ask.local })) };
  } catch (err) {
    reply = { id: ask.id, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
