import WebSocket from 'ws';
import { PING_TEXT, PONG_TEXT, SOCKET_PING_MS, SOCKET_SILENCE_MS, WHARF_SOCKET_PROTOCOL } from '@lobstah/core';
import type { BackendLocation, ClientSocketMessage, CommandMessage, ServerSocketMessage } from '@lobstah/core';

/**
 * A boat's or a helm's socket to its wharf account (lobstah.2), bearer in
 * the upgrade's header only. It resumes from its last cursor on every
 * connect, so a drop, an eviction or a deploy loses nothing; pings every
 * SOCKET_PING_MS, which the wharf's runtime answers without waking the
 * account; and reconnects after a drop or SOCKET_SILENCE_MS of silence,
 * backing off from RECONNECT_MIN_MS to RECONNECT_MAX_MS with jitter.
 *
 * `onMessage` hears every message. `wait`/`heard` serve a loop that sleeps
 * until a message of one of `kinds` arrives (the helm's wait hears `event`).
 * `command` runs one route on the socket and resolves with its result.
 */

/** The first reconnect waits this long, doubling after each failure up to RECONNECT_MAX_MS. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** The largest message the wharf sends a boat (a pushed call with its payload). */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface WharfSocketOptions {
  /** Message kinds that end a `wait`. */
  kinds?: readonly string[];
  /** This lobstah's version, sent with each resume. */
  client?: string;
  /** Every message the wharf sends, in order. */
  onMessage?: (message: ServerSocketMessage) => void;
  /** The socket opened (and resumed) or dropped. */
  onState?: (open: boolean) => void;
  /** The cursor to resume after on the first connect: the helm's `--after`. */
  after?: string;
  /** Jitter source, for tests. */
  random?: () => number;
}

/** A command's outcome on the socket: the status and body its HTTP route would give. */
export interface SocketResult {
  status: number;
  value: unknown;
}

export class WharfSocket {
  private socket?: WebSocket;
  private stopped = false;
  private cursor?: string;
  private retryMs = RECONNECT_MIN_MS;
  private retry?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private silence?: ReturnType<typeof setTimeout>;
  private pending = false;
  private finish?: () => void;
  private readonly received = new Set<string>();
  private readonly results = new Map<string, (result: SocketResult | undefined) => void>();
  constructor(
    private readonly location: BackendLocation,
    private readonly credential: string,
    private readonly options: WharfSocketOptions = {},
  ) {
    this.cursor = options.after;
  }

  /** Connect now and keep the socket open until `close`. */
  start(): void {
    this.connect();
  }

  /** Whether the socket is open now. */
  connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Send one message; false when the socket is not open. */
  send(message: ClientSocketMessage): boolean {
    if (!this.connected()) return false;
    this.socket!.send(JSON.stringify(message));
    return true;
  }

  /** Send one binary frame (a snapshot or an answer); false when the socket is not open. */
  sendFrame(frame: Uint8Array): boolean {
    if (!this.connected()) return false;
    this.socket!.send(frame);
    return true;
  }

  /**
   * Run one route on the socket, as its HTTP route would, under this
   * socket's credential. `id` is the idempotency key, so a caller that
   * gets undefined (the socket is down, or no result within `timeoutMs`)
   * may send the same command over HTTP with the same key.
   */
  command(command: Omit<CommandMessage, 't'>, timeoutMs = 10_000): Promise<SocketResult | undefined> {
    if (!this.send({ t: 'command', ...command })) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      const settle = (result: SocketResult | undefined) => {
        clearTimeout(timer);
        this.results.delete(command.id);
        resolve(result);
      };
      this.results.set(command.id, settle);
    });
  }

  /** The newest cursor this socket has heard. */
  lastCursor(): string | undefined {
    return this.cursor;
  }

  /** Wait up to `milliseconds`, or until a message of one of `kinds` arrives (or one arrived since the last wait). */
  wait(milliseconds: number): Promise<void> {
    this.connect();
    if (this.pending || this.stopped) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.finish = undefined;
        this.pending = false;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.finish = finish;
    });
  }

  /** Whether a message of this kind arrived since the last ask; asking clears it. */
  heard(kind: string): boolean {
    const had = this.received.has(kind);
    this.received.delete(kind);
    return had;
  }

  /** Close for good: no reconnect. */
  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopTimers();
    this.finish?.();
    this.settleAll();
    this.socket?.terminate();
    this.socket = undefined;
  }

  /** Commands in flight end without a result when their socket goes. */
  private settleAll(): void {
    for (const settle of [...this.results.values()]) settle(undefined);
  }

  private connect(): void {
    if (this.stopped || this.socket || this.retry) return;
    const url = new URL(`${this.location.url}/v1/accounts/${encodeURIComponent(this.location.account)}/wake`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, WHARF_SOCKET_PROTOCOL, {
      headers: { Authorization: `Bearer ${this.credential}` },
      followRedirects: false,
      handshakeTimeout: 5000,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    this.socket = socket;
    socket.on('open', () => {
      this.retryMs = RECONNECT_MIN_MS;
      socket.send(JSON.stringify({ t: 'resume', ...(this.cursor ? { after: this.cursor } : {}), ...(this.options.client ? { client: this.options.client } : {}) }));
      this.pinger = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(PING_TEXT);
      }, SOCKET_PING_MS);
      this.heardFromWharf(socket);
      this.options.onState?.(true);
      this.wake();
    });
    socket.on('message', (value, binary) => {
      this.heardFromWharf(socket);
      if (binary) return;
      const text = value.toString();
      if (text === PONG_TEXT) return;
      let message: ServerSocketMessage;
      try {
        message = JSON.parse(text) as ServerSocketMessage;
      } catch {
        return;
      }
      if (message.t === 'event' || message.t === 'hello') this.cursor = message.cursor;
      if (message.t === 'result') this.results.get(message.id)?.(message);
      this.options.onMessage?.(message);
      if (this.options.kinds?.includes(message.t)) {
        this.received.add(message.t);
        this.wake();
      }
    });
    socket.on('error', () => {
      /* 'close' follows; the credential is never logged. */
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stopTimers();
      this.settleAll();
      this.options.onState?.(false);
      this.wake();
      this.scheduleReconnect();
    });
  }

  /** Any message, a pong included, says the connection is alive; long silence means it is not. */
  private heardFromWharf(socket: WebSocket): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => socket.terminate(), SOCKET_SILENCE_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const jitter = 0.5 + (this.options.random ?? Math.random)();
    const delay = Math.min(this.retryMs * jitter, RECONNECT_MAX_MS);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, delay);
  }

  private stopTimers(): void {
    if (this.pinger) clearInterval(this.pinger);
    if (this.silence) clearTimeout(this.silence);
    this.pinger = this.silence = undefined;
  }

  private wake(): void {
    this.pending = true;
    this.finish?.();
  }
}
