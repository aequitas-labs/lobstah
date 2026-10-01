import { parentPort } from 'node:worker_threads';
import type { GlassOlderKind } from '@lobstah/core';
import { glassDispatchJson, glassOlderJson, glassPoll } from './glass.js';
import type { PollBody } from './glass-poll.js';

/**
 * The glass's snapshot thread. The server's own thread only answers HTTP;
 * this thread builds each /data body, each page of older history, and each
 * dispatch's detail, so a page load or a focus click never waits behind a
 * snapshot. It lives as long as the server, which keeps its git answers
 * (liveness-view.ts) warm between polls.
 */
export type SnapshotAsk =
  | { id: number; want: 'poll'; local: boolean }
  | { id: number; want: 'older'; kind: GlassOlderKind; offset: number; limit: number }
  | { id: number; want: 'dispatch'; dispatch: string };
export type SnapshotReply = { id: number; poll: PollBody } | { id: number; json: string | null } | { id: number; error: string };

parentPort?.on('message', (ask: SnapshotAsk) => {
  let reply: SnapshotReply;
  try {
    if (ask.want === 'poll') reply = { id: ask.id, poll: glassPoll(ask.local) };
    else if (ask.want === 'older') reply = { id: ask.id, json: glassOlderJson(ask.kind, ask.offset, ask.limit) };
    else reply = { id: ask.id, json: glassDispatchJson(ask.dispatch) };
  } catch (err) {
    reply = { id: ask.id, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
