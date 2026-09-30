import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { COMPILED_BINARY } from '@lobstah/core';
import type { SnapshotAsk, SnapshotReply } from './glass-snapshot-worker.js';

/**
 * The server side of the snapshot thread (glass-snapshot-worker.ts). A /data
 * request asks the thread for a body; requests that arrive while one is being
 * built share it. When the thread cannot start or dies, `build` rejects and
 * the server builds the snapshot on its own thread, as before.
 */
export interface SnapshotThread {
  /** A /data body without the page token, as JSON. */
  build(local: boolean): Promise<string>;
  close(): Promise<void>;
}

/** The worker entry: the compiled binary embeds it as a second entrypoint, named relative to main.ts; a node install loads the built file beside this one. */
function workerEntry(): string | URL | undefined {
  if (COMPILED_BINARY) return './glass-snapshot-worker.ts';
  const url = new URL('./glass-snapshot-worker.js', import.meta.url);
  return fs.existsSync(fileURLToPath(url)) ? url : undefined;
}

export function startSnapshotThread(): SnapshotThread | undefined {
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
  const waiting = new Map<number, { resolve: (body: string) => void; reject: (err: Error) => void }>();
  const inFlight = new Map<boolean, Promise<string>>();
  const fail = (err: Error) => {
    dead ??= err;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    inFlight.clear();
  };
  worker.on('message', (reply: SnapshotReply) => {
    const w = waiting.get(reply.id);
    if (!w) return;
    waiting.delete(reply.id);
    if ('body' in reply) w.resolve(reply.body);
    else w.reject(new Error(reply.error));
  });
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`snapshot thread exited (${code})`)));
  return {
    build(local: boolean): Promise<string> {
      if (dead) return Promise.reject(dead);
      const pending = inFlight.get(local);
      if (pending) return pending;
      const id = ++next;
      const promise = new Promise<string>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, local } satisfies SnapshotAsk);
      }).finally(() => inFlight.delete(local));
      inFlight.set(local, promise);
      return promise;
    },
    async close(): Promise<void> {
      fail(new Error('snapshot thread closed'));
      await worker.terminate();
    },
  };
}
