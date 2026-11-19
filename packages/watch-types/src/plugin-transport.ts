import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { WatchPluginError, watchPluginEnvironment } from './plugin-model.js';
import type { WatchPluginConfiguration, WatchPluginContext, WatchPluginRequest } from './plugin-model.js';
import type { WatchFailure, WatchValue } from './model.js';
import { watchJson } from './registry.js';

interface Response {
  kind: 'reply';
  id: string;
  ok: boolean;
  value?: WatchValue;
  message?: string;
  failure?: WatchFailure;
}
interface Stream {
  values: WatchValue[];
  done: boolean;
  error?: Error;
  wake?: () => void;
}

/** Persistent child IO runs off-thread so the required synchronous adapter methods retain their contract. */
export class WatchPluginTransport {
  private readonly worker: Worker;
  private readonly pending = new Map<string, { resolve(value: WatchValue): void; reject(error: Error): void }>();
  private readonly streams = new Map<string, Stream>();
  private disposed = false;
  private disposal?: Promise<void>;
  private finishDisposal?: () => void;
  constructor(
    readonly configuration: WatchPluginConfiguration,
    ambient: NodeJS.ProcessEnv = process.env,
  ) {
    this.worker = new Worker(new URL('./plugin-worker.js', import.meta.url), {
      workerData: { configuration, environment: watchPluginEnvironment(configuration.envAllow, ambient) },
    });
    this.worker.on(
      'message',
      (
        message: Response | { kind: 'observation'; id: string; params: WatchPluginContext & { batch: WatchValue } } | { kind: 'disposed' },
      ) => {
        if (message.kind === 'disposed') {
          this.finishDisposal?.();
          void this.worker.terminate();
          return;
        }
        if (message.kind === 'observation') {
          const stream = this.streams.get(message.id);
          if (!stream || stream.done) return;
          if (stream.values.length >= 1000) {
            stream.error = new WatchPluginError('Watch plugin subscription queue is full');
            stream.done = true;
            this.worker.postMessage({ kind: 'cancel', id: message.id });
          } else stream.values.push(message.params.batch);
          stream.wake?.();
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value ?? null);
        else pending.reject(new WatchPluginError(message.message ?? 'Watch plugin request failed', message.failure));
        this.updateReference();
      },
    );
    this.worker.on('error', (error) => this.failed(error));
    this.worker.on('exit', () => {
      this.failed(new Error('Watch plugin IO worker exited'));
      this.finishDisposal?.();
    });
    this.worker.unref();
  }

  private updateReference(): void {
    if (this.pending.size || this.streams.size) this.worker.ref();
    else this.worker.unref();
  }
  private failed(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.error = error;
      stream.done = true;
      stream.wake?.();
    }
  }
  private request(method: string, body: unknown, context?: Partial<WatchPluginContext>): WatchPluginRequest {
    if (this.disposed) throw new WatchPluginError('Watch plugin transport is closed');
    return {
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params: {
        protocolVersion: 1,
        watchKey: context?.watchKey ?? `@installation:${this.configuration.id}`,
        generation: context?.generation ?? 'installation',
        deadline: context?.deadline ?? Date.now() + this.configuration.requestTimeoutMs,
        body: watchJson(body),
      },
    };
  }

  /** Deadline and output bounds are checked again while publishing the shared reply. */
  callSync(method: string, body: unknown, context?: Partial<WatchPluginContext>): WatchValue {
    const request = this.request(method, body, context),
      shared = new SharedArrayBuffer(this.configuration.maxMessageBytes + 8),
      control = new Int32Array(shared, 0, 2);
    this.worker.postMessage({ kind: 'call', request, shared });
    const timeout = Math.max(1, request.params.deadline - Date.now()) + 1000;
    if (Atomics.wait(control, 0, 0, timeout) === 'timed-out') {
      void this.dispose();
      throw new WatchPluginError('Watch plugin IO worker missed its deadline');
    }
    const length = Atomics.load(control, 1);
    if (length <= 0 || length > this.configuration.maxMessageBytes)
      throw new WatchPluginError('Watch plugin shared reply has an invalid size');
    const response = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, length))) as Omit<Response, 'kind' | 'id'>;
    if (!response.ok) throw new WatchPluginError(response.message ?? 'Watch plugin request failed', response.failure);
    return watchJson(response.value ?? null);
  }

  /** Async hosts share the same persistent process and wire format. */
  call(method: string, body: unknown, context?: Partial<WatchPluginContext>): Promise<WatchValue> {
    const request = this.request(method, body, context);
    const result = new Promise<WatchValue>((resolve, reject) => this.pending.set(request.id, { resolve, reject }));
    this.updateReference();
    this.worker.postMessage({ kind: 'call', request });
    return result;
  }

  /** A subscription has bounded lifetime and resumes from the caller’s next committed snapshot. */
  async *subscribe(body: unknown, context: WatchPluginContext, signal?: AbortSignal): AsyncIterable<WatchValue> {
    const request = this.request('watch.subscribe', body, context),
      stream: Stream = { values: [], done: false };
    this.streams.set(request.id, stream);
    const result = new Promise<WatchValue>((resolve, reject) => this.pending.set(request.id, { resolve, reject }));
    void result.then(
      () => {
        stream.done = true;
        stream.wake?.();
      },
      (error: Error) => {
        stream.error = error;
        stream.done = true;
        stream.wake?.();
      },
    );
    const abort = () => {
      this.worker.postMessage({ kind: 'cancel', id: request.id });
      stream.done = true;
      stream.wake?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.updateReference();
    this.worker.postMessage({ kind: 'call', request, subscribe: true });
    try {
      for (;;) {
        while (stream.values.length && !signal?.aborted) {
          const value = stream.values.shift()!;
          this.worker.postMessage({ kind: 'ack', id: request.id });
          yield watchJson(value);
        }
        if (stream.error) throw stream.error;
        if (stream.done || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          stream.wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      abort();
      this.streams.delete(request.id);
      this.updateReference();
    }
  }

  /** Only this transport’s owned child and worker are stopped. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = new Promise<void>((resolve) => {
      this.finishDisposal = resolve;
    });
    this.worker.ref();
    this.worker.postMessage({ kind: 'shutdown' });
    const timeout = setTimeout(() => {
      void this.worker.terminate();
      this.finishDisposal?.();
    }, 2000);
    timeout.unref();
    return this.disposal.finally(() => clearTimeout(timeout));
  }
}
