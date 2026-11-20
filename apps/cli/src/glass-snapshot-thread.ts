import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { COMPILED_BINARY } from '@lobstah/core';
import type { GlassOlderKind } from '@lobstah/core';
import type { PollBody } from './glass-poll.js';
import type { SnapshotAsk, SnapshotReply } from './glass-snapshot-worker.js';

/**
 * The server side of the snapshot thread (glass-snapshot-worker.ts). A /data
 * request asks the thread for a body; requests that arrive while one is being
 * built share it. When the thread cannot start or dies, every ask rejects and
 * the server answers on its own thread, as before.
 */
export interface SnapshotThread {
  /** A /data body without the page token, its content hash, and its beats. */
  poll(local: boolean): Promise<PollBody>;
  /** Drop the reused body: this glass just changed something its pages should see at once. */
  invalidate(): void;
  /** A page of older history, as JSON. */
  older(kind: GlassOlderKind, offset: number, limit: number): Promise<string>;
  /** One dispatch's detail as JSON, or null when there is none. */
  dispatch(id: string): Promise<string | null>;
  close(): Promise<void>;
}

/**
 * How long a built body answers later polls. Every open page and the pet poll
 * every two seconds, and each build reads the whole fleet state, so each
 * build is shared. While nothing changes, the window doubles up to the
 * idle maximum: an unchanged fleet costs one build every ten seconds.
 */
export const POLL_REUSE_MS = 2000;
export const POLL_REUSE_IDLE_MS = 10_000;
export function pollReuseMs(unchanged: number): number {
  return Math.min(POLL_REUSE_IDLE_MS, POLL_REUSE_MS * 2 ** Math.min(unchanged, 8));
}

/** The last body built for local and remote viewers, and how many builds in a row it stayed the same. */
export function pollReuse(now: () => number = Date.now) {
  const built = new Map<boolean, { at: number; body: PollBody; unchanged: number }>();
  return {
    /** The body to answer with, while its window lasts. */
    reused(local: boolean): PollBody | undefined {
      const last = built.get(local), at = now();
      return last && at - last.at >= 0 && at - last.at < pollReuseMs(last.unchanged) ? last.body : undefined;
    },
    record(local: boolean, body: PollBody): void {
      const before = built.get(local);
      built.set(local, { at: now(), body, unchanged: before?.body.hash === body.hash ? before.unchanged + 1 : 0 });
    },
    clear(): void {
      built.clear();
    },
  };
}

/** An ask without its id, which the thread assigns. */
type Ask = SnapshotAsk extends infer A ? (A extends { id: number } ? Omit<A, 'id'> : never) : never;

/** The worker entry: the compiled binary embeds it as a second entrypoint, named relative to main.ts; a node install loads the built file beside this one. */
function workerEntry(): string | URL | undefined {
  if (COMPILED_BINARY) return './glass-snapshot-worker.ts';
  const url = new URL('./glass-snapshot-worker.js', import.meta.url);
  return fs.existsSync(fileURLToPath(url)) ? url : undefined;
}

export function startSnapshotThread(now: () => number = Date.now): SnapshotThread | undefined {
  const entry = workerEntry();
  if (entry === undefined) return undefined;
  let worker: Worker;
  try {
    worker = new Worker(entry);
  } catch {
    return undefined;
  }
  worker.unref();
  let dead: Error | undefined;
  let next = 0;
  const waiting = new Map<number, { resolve: (reply: SnapshotReply) => void; reject: (err: Error) => void }>();
  const inFlight = new Map<boolean, Promise<PollBody>>();
  const reuse = pollReuse(now);
  const fail = (err: Error) => {
    dead ??= err;
    reuse.clear();
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    inFlight.clear();
  };
  worker.on('message', (reply: SnapshotReply) => {
    const w = waiting.get(reply.id);
    if (!w) return;
    waiting.delete(reply.id);
    if ('error' in reply) w.reject(new Error(reply.error));
    else w.resolve(reply);
  });
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`snapshot thread exited (${code})`)));
  const ask = (a: Ask): Promise<SnapshotReply> => {
    if (dead) return Promise.reject(dead);
    const id = ++next;
    return new Promise<SnapshotReply>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...a, id } as SnapshotAsk);
    });
  };
  const json = (reply: SnapshotReply): string | null => ('json' in reply ? reply.json : null);
  return {
    poll(local: boolean): Promise<PollBody> {
      const pending = inFlight.get(local);
      if (pending) return pending;
      const reused = reuse.reused(local);
      if (reused) return Promise.resolve(reused);
      const promise = ask({ want: 'poll', local })
        .then((reply) => {
          if (!('poll' in reply)) throw new Error('snapshot thread answered a poll without a body');
          reuse.record(local, reply.poll);
          return reply.poll;
        })
        .finally(() => inFlight.delete(local));
      inFlight.set(local, promise);
      return promise;
    },
    invalidate: () => reuse.clear(),
    older: (kind, offset, limit) => ask({ want: 'older', kind, offset, limit }).then((reply) => json(reply) ?? '{}'),
    dispatch: (id) => ask({ want: 'dispatch', dispatch: id }).then(json),
    async close(): Promise<void> {
      fail(new Error('snapshot thread closed'));
      await worker.terminate();
    },
  };
}
