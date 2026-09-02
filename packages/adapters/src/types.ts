import type { DispatchLimits, NormalizedEvent } from '@lobstah/core';

export interface AdapterStartOpts {
  id: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  limits: DispatchLimits;
  env: Record<string, string>;
  flags: string[];
  resumeSession?: string;
}

export interface AdapterRun {
  events: AsyncIterable<NormalizedEvent>;
  /** Queue a user message for the next turn. */
  send(text: string): void;
  /** No more input — finish after the current turn. */
  end(): void;
  done: Promise<{ sessionId?: string; error?: string }>;
  kill(): void;
}

export interface Adapter {
  name: string;
  start(opts: AdapterStartOpts): Promise<AdapterRun>;
}

/** Small async channel: push from the SDK pump, iterate from the runner. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Await-able input gate shared by both adapters for between-turn delivery. */
export class InputGate {
  private queue: string[] = [];
  private waiter: (() => void) | null = null;
  ended = false;

  send(text: string): void {
    this.queue.push(text);
    this.waiter?.();
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
  }

  /** Resolves with the next message, or undefined once ended and drained. */
  async next(): Promise<string | undefined> {
    while (true) {
      const msg = this.queue.shift();
      if (msg !== undefined) return msg;
      if (this.ended) return undefined;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = null;
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}
