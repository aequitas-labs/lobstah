import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WatchPluginConfiguration, WatchPluginReply, WatchPluginRequest } from './plugin-model.js';
import type { WatchFailure } from './model.js';

interface WorkerSettings {
  configuration: WatchPluginConfiguration;
  environment: NodeJS.ProcessEnv;
}
interface Work {
  kind: 'call';
  request: WatchPluginRequest;
  shared?: SharedArrayBuffer;
  subscribe?: boolean;
}
interface Pending {
  request: WatchPluginRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  subscribe: boolean;
  unacknowledged: number;
}
const settings = workerData as WorkerSettings,
  port = parentPort!;
const configuration = settings.configuration;
let child: ChildProcessWithoutNullStreams | undefined, startup: Promise<unknown> | undefined, manifest: unknown;
let manifestText: string | undefined,
  stdout = '',
  stderr = '',
  stopping = false;
let failures: number[] = [],
  restartAt = 0;
const pending = new Map<string, Pending>(),
  cancelled = new Set<string>();

/** Shared replies unblock the synchronous facade while all process IO stays on this worker. */
function reply(work: Work, value: unknown, error?: Error): void {
  const failure: WatchFailure | undefined = error ? (error as Error & { failure?: WatchFailure }).failure : undefined;
  const result = error ? { ok: false, message: error.message, ...(failure ? { failure } : {}) } : { ok: true, value };
  if (!work.shared) {
    port.postMessage({ kind: 'reply', id: work.request.id, ...result });
    return;
  }
  const control = new Int32Array(work.shared, 0, 2),
    bytes = new Uint8Array(work.shared, 8);
  let encoded = new TextEncoder().encode(JSON.stringify(result));
  if (encoded.byteLength > bytes.byteLength)
    encoded = new TextEncoder().encode(JSON.stringify({ ok: false, message: 'Watch plugin reply exceeded its message limit' }));
  bytes.set(encoded);
  Atomics.store(control, 1, encoded.byteLength);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function failAll(error: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}
function fault(message: string): void {
  const current = child;
  child = undefined;
  manifest = undefined;
  startup = undefined;
  const now = Date.now();
  failures = failures.filter((at) => now - at < configuration.restartWindowMs);
  failures.push(now);
  restartAt = now + Math.min(30_000, configuration.restartBackoffMs * 2 ** Math.min(failures.length - 1, 8));
  failAll(new Error(message));
  if (current && !current.killed) {
    current.kill();
    setTimeout(() => {
      if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
    }, 500).unref();
  }
}

/** Validate framing and generation before forwarding any subscription data to the main thread. */
function line(text: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    fault('Watch plugin emitted malformed JSON');
    return;
  }
  if (!message || message.jsonrpc !== '2.0') {
    fault('Watch plugin emitted an unsupported JSON-RPC message');
    return;
  }
  if (message.method === 'watch.observation') {
    const params = message.params as Record<string, unknown> | undefined,
      id = params?.requestId;
    const entry = typeof id === 'string' ? pending.get(id) : undefined;
    if (
      !entry ||
      !entry.subscribe ||
      params?.protocolVersion !== 1 ||
      params.watchKey !== entry.request.params.watchKey ||
      params.generation !== entry.request.params.generation ||
      params.deadline !== entry.request.params.deadline
    ) {
      fault('Watch plugin subscription generation or request does not match');
      return;
    }
    if (++entry.unacknowledged > 1000) {
      fault('Watch plugin subscription exceeded its bounded queue');
      return;
    }
    port.postMessage({ kind: 'observation', id, params });
    return;
  }
  const id = message.id;
  if (typeof id !== 'string') {
    fault('Watch plugin response has no request ID');
    return;
  }
  const entry = pending.get(id);
  if (!entry) {
    if (cancelled.delete(id)) return;
    fault('Watch plugin response has an unknown request ID');
    return;
  }
  pending.delete(id);
  clearTimeout(entry.timer);
  if ('result' in message === 'error' in message) {
    entry.reject(new Error('Watch plugin response must have one result or error'));
    fault('Invalid watch plugin response');
    return;
  }
  if (message.error) {
    const detail = message.error as NonNullable<WatchPluginReply['error']>;
    const error = new Error(typeof detail.message === 'string' ? detail.message : 'Watch plugin operation failed') as Error & {
      failure?: WatchFailure;
    };
    if (detail.data?.failure) error.failure = detail.data.failure;
    entry.reject(error);
  } else entry.resolve(message.result);
}

function rpc(request: WatchPluginRequest, subscribe = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!child || request.params.deadline <= Date.now()) {
      reject(new Error('Watch plugin request deadline expired'));
      return;
    }
    const timer = setTimeout(
      () => fault(`Watch plugin ${request.method} missed its deadline`),
      Math.max(1, request.params.deadline - Date.now()),
    );
    pending.set(request.id, { request, resolve, reject, timer, subscribe, unacknowledged: 0 });
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text) > configuration.maxMessageBytes) {
      pending.delete(request.id);
      clearTimeout(timer);
      reject(new Error('Watch plugin request exceeded its message limit'));
      return;
    }
    child.stdin.write(text + '\n', (error) => {
      if (error) fault(`Watch plugin stdin failed: ${error.message}`);
    });
  });
}

/** A restart repeats the pinned handshake before any watch operation can execute. */
async function ensureStarted(): Promise<unknown> {
  if (manifest) return manifest;
  if (startup) return startup;
  const now = Date.now();
  failures = failures.filter((at) => now - at < configuration.restartWindowMs);
  if (now < restartAt) throw new Error('Watch plugin restart backoff is active');
  if (failures.length > configuration.maxRestarts)
    throw new Error('Watch plugin crash limit reached; wait for its restart window before releasing watches');
  startup = (async () => {
    stdout = '';
    stderr = '';
    const process = spawn(configuration.command[0]!, configuration.command.slice(1), {
      cwd: configuration.cwd,
      env: settings.environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = process;
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => {
      if (child !== process) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > configuration.maxMessageBytes * 2) {
        fault('Watch plugin stdout exceeded its bounded buffer');
        return;
      }
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const next = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!next.trim()) continue;
        if (Buffer.byteLength(next) > configuration.maxMessageBytes) {
          fault('Watch plugin message exceeded its size limit');
          return;
        }
        line(next);
        if (child !== process) return;
      }
    });
    process.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    process.on('error', (error) => {
      if (child === process) fault(`Watch plugin could not start: ${error.message}`);
    });
    process.on('exit', (code, signal) => {
      if (child === process && !stopping)
        fault(`Watch plugin exited unexpectedly (${signal ?? code})${stderr ? ': ' + stderr.slice(0, 1000).trim() : ''}`);
    });
    const result = await rpc({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'watch.handshake',
      params: {
        protocolVersion: 1,
        watchKey: `@installation:${configuration.id}`,
        generation: 'installation',
        deadline: Date.now() + configuration.startupTimeoutMs,
        body: { id: configuration.id, apiVersion: configuration.apiVersion, version: configuration.version },
      },
    });
    const declaration = result as {
      protocolVersion?: number;
      presentationVersion?: number;
      descriptor?: { id?: string; apiVersion?: number; version?: string };
    };
    if (
      declaration?.protocolVersion !== 1 ||
      (declaration.presentationVersion !== 1 && declaration.presentationVersion !== 2) ||
      declaration.descriptor?.id !== configuration.id ||
      declaration.descriptor.apiVersion !== 1 ||
      declaration.descriptor.version !== configuration.version
    ) {
      fault('Watch plugin handshake differs from the configured API or release');
      throw new Error('Watch plugin handshake differs from the configured API or release');
    }
    const nextText = JSON.stringify(result);
    if (manifestText !== undefined && manifestText !== nextText) {
      fault('Watch plugin manifest changed during restart');
      throw new Error('Watch plugin manifest changed during restart');
    }
    manifestText = nextText;
    manifest = result;
    return result;
  })();
  try {
    return await startup;
  } finally {
    startup = undefined;
  }
}

port.on('message', (message: Work | { kind: 'cancel'; id: string } | { kind: 'ack'; id: string } | { kind: 'shutdown' }) => {
  if (message.kind === 'shutdown') {
    stopping = true;
    failAll(new Error('Watch plugin host closed'));
    const current = child;
    child = undefined;
    if (current) {
      current.once('exit', () => {
        port.postMessage({ kind: 'disposed' });
        port.close();
      });
      current.kill();
      setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
      }, 500).unref();
    } else {
      port.postMessage({ kind: 'disposed' });
      port.close();
    }
    return;
  }
  if (message.kind === 'ack') {
    const entry = pending.get(message.id);
    if (entry) entry.unacknowledged = Math.max(0, entry.unacknowledged - 1);
    return;
  }
  if (message.kind === 'cancel') {
    const entry = pending.get(message.id);
    if (!entry) {
      cancelled.add(message.id);
      if (cancelled.size > 1000) cancelled.delete(cancelled.values().next().value!);
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve({ closed: true });
    cancelled.add(message.id);
    if (cancelled.size > 1000) cancelled.delete(cancelled.values().next().value!);
    child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'watch.cancel', params: { requestId: message.id } }) + '\n');
    return;
  }
  void (async () => {
    try {
      const declaration = await ensureStarted();
      if (cancelled.delete(message.request.id)) {
        reply(message, { closed: true });
        return;
      }
      const result = message.request.method === 'watch.handshake' ? declaration : await rpc(message.request, message.subscribe);
      reply(message, result);
    } catch (error) {
      reply(message, undefined, error instanceof Error ? error : new Error(String(error)));
    }
  })();
});
