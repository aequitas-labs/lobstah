import type { BackendEvent } from './backend-model.js';

/**
 * The wharf's live channel: one hibernatable WebSocket per boat and per
 * glass tab, on the account's `wake` upgrade. A client asks for
 * WHARF_SOCKET_PROTOCOL; the wharf refuses any other upgrade with 426 and
 * MINIMUM_SOCKET_CLIENT. Every message is one JSON object with a `t` field,
 * except the keepalive: the client sends the bare text `ping`, and the wharf
 * answers `pong` without waking its account's object.
 */

/** The subprotocol a client asks for on the upgrade. */
export const WHARF_SOCKET_PROTOCOL = 'lobstah.2';

/** The first lobstah release whose boats speak WHARF_SOCKET_PROTOCOL. Raise it with the release that ships the boat's socket client. */
export const MINIMUM_SOCKET_CLIENT = '0.8.10';

/** The keepalive's two texts. The wharf's auto-response answers PING_TEXT with PONG_TEXT. */
export const PING_TEXT = 'ping';
export const PONG_TEXT = 'pong';

/** How often a client pings, and how long it waits for any message before it reconnects. */
export const SOCKET_PING_MS = 30_000;
export const SOCKET_SILENCE_MS = 75_000;

/** The most events one `event` message carries; a resume sends several when more were missed. */
export const SOCKET_EVENTS_PER_MESSAGE = 100;

/** Catch up from a cursor: every event after it, then `hello`. With no cursor, `hello` alone. */
export interface ResumeMessage {
  t: 'resume';
  after?: string;
  /** The client's lobstah version, recorded on its boat. */
  client?: string;
}

/**
 * Run one command, as the same HTTP route would. `id` is its idempotency
 * key: the wharf applies a command once and answers a repeat with the same
 * result.
 */
export interface CommandMessage {
  t: 'command';
  id: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  /** The helm session, as `X-Lobstah-Helm` on HTTP. */
  session?: string;
}

/**
 * A glass tab's relayed call to one boat: a read of its glass, or a write,
 * with files uploaded first over HTTP. `id` is the call's id: the boat's
 * answer comes back as an `answer` frame under it, and a repeat of the same
 * id is the same call.
 */
export interface CallMessage {
  t: 'call';
  id: string;
  boat: string;
  read?: string;
  write?: { kind: string; payload: unknown };
  files?: string[];
}

export type ClientSocketMessage = ResumeMessage | CommandMessage | CallMessage;

/** New events, in order; `cursor` is the newest one's. */
export interface EventMessage {
  t: 'event';
  events: BackendEvent[];
  cursor: string;
}

/** Sent after a resume's events: the client is caught up to `cursor`. */
export interface HelloMessage {
  t: 'hello';
  protocol: typeof WHARF_SOCKET_PROTOCOL;
  cursor: string;
}

/** A command's outcome, under the command's id: the HTTP status and body the same route would give. */
export interface ResultMessage {
  t: 'result';
  id: string;
  status: number;
  value: unknown;
}

/** A message the wharf could not act on, and why. */
export interface ErrorMessage {
  t: 'error';
  reason: string;
  id?: string;
}

export type ServerSocketMessage = EventMessage | HelloMessage | ResultMessage | ErrorMessage;

/**
 * A boat's new glass snapshot, pushed to glass tabs as a binary frame whose
 * payload is the gzip the boat put: the tab unpacks it and shows it, with no
 * request.
 */
export interface SnapshotFrame {
  t: 'snapshot';
  boat: string;
  name: string;
  at: string;
  etag: string;
}

/**
 * A boat's answer to a relayed call, as a binary frame whose payload is the
 * boat's response body. An answer over ANSWER_INLINE_MAX_BYTES comes with
 * `large` and no payload: a read is fetched again over HTTP.
 */
export interface AnswerFrame {
  t: 'answer';
  id: string;
  status: number;
  contentType: string;
  large?: true;
}

export type SocketFrame = SnapshotFrame | AnswerFrame;

/** The largest answer body pushed in its frame; a larger one is read over HTTP. */
export const ANSWER_INLINE_MAX_BYTES = 1024 * 1024;

/** A binary frame: the header's length (4 bytes, big-endian), the header as JSON, then the payload. */
export function encodeFrame(header: SocketFrame, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength);
  out.set(head, 4);
  out.set(payload, 4 + head.byteLength);
  return out;
}

/** A binary frame's header and payload, or undefined when the bytes are not a frame. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): { header: SocketFrame; payload: Uint8Array } | undefined {
  // A view or a buffer, from this realm or another (a frame handed across realms fails instanceof).
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.byteLength < 4) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + length > bytes.byteLength) return undefined;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as SocketFrame;
    if (header?.t !== 'snapshot' && header?.t !== 'answer') return undefined;
    return { header, payload: bytes.subarray(4 + length) };
  } catch {
    return undefined;
  }
}

/** Command ids share HTTP's Idempotency-Key alphabet. */
const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const METHODS = new Set(['GET', 'POST', 'PUT']);

/** A client's message as the wharf accepts it, or the reason it doesn't. */
export function parseClientMessage(text: string): ClientSocketMessage | { invalid: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { invalid: 'not JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: 'not a message object' };
  const m = value as Record<string, unknown>;
  if (m.t === 'resume') {
    if (m.after !== undefined && typeof m.after !== 'string') return { invalid: 'after must be a cursor' };
    if (m.client !== undefined && (typeof m.client !== 'string' || m.client.length > 64)) return { invalid: 'client must be a version' };
    return { t: 'resume', ...(m.after !== undefined ? { after: m.after as string } : {}), ...(m.client !== undefined ? { client: m.client as string } : {}) };
  }
  if (m.t === 'command') {
    if (typeof m.id !== 'string' || !COMMAND_ID.test(m.id)) return { invalid: 'command id must match the Idempotency-Key alphabet' };
    if (typeof m.method !== 'string' || !METHODS.has(m.method)) return { invalid: 'command method must be GET, POST or PUT' };
    if (typeof m.path !== 'string' || !m.path || m.path.length > 512 || m.path.startsWith('/')) return { invalid: 'command path must be an account route' };
    if (m.session !== undefined && typeof m.session !== 'string') return { invalid: 'session must be a string' };
    return {
      t: 'command',
      id: m.id,
      method: m.method as CommandMessage['method'],
      path: m.path,
      ...(m.body !== undefined ? { body: m.body } : {}),
      ...(m.session !== undefined ? { session: m.session as string } : {}),
    };
  }
  if (m.t === 'call') {
    if (typeof m.id !== 'string' || !COMMAND_ID.test(m.id)) return { invalid: 'call id must match the Idempotency-Key alphabet' };
    if (typeof m.boat !== 'string' || !COMMAND_ID.test(m.boat)) return { invalid: 'call boat must be a boat id' };
    if ((m.read === undefined) === (m.write === undefined)) return { invalid: 'a call is a read or a write' };
    if (m.read !== undefined && (typeof m.read !== 'string' || !m.read.startsWith('/') || m.read.length > 2048)) return { invalid: 'read must be a glass path' };
    if (m.write !== undefined) {
      const w = m.write as Record<string, unknown> | null;
      if (!w || typeof w !== 'object' || typeof w.kind !== 'string') return { invalid: 'write must name its request kind' };
    }
    if (m.files !== undefined && (!Array.isArray(m.files) || m.files.length > 32 || m.files.some((f) => typeof f !== 'string' || !COMMAND_ID.test(f)))) {
      return { invalid: 'files must be uploaded file ids' };
    }
    return {
      t: 'call',
      id: m.id,
      boat: m.boat,
      ...(m.read !== undefined ? { read: m.read as string } : {}),
      ...(m.write !== undefined ? { write: m.write as CallMessage['write'] } : {}),
      ...(m.files !== undefined ? { files: m.files as string[] } : {}),
    };
  }
  return { invalid: 'unknown message type' };
}

/** Whether an upgrade's `Sec-WebSocket-Protocol` header offers WHARF_SOCKET_PROTOCOL. */
export function offersSocketProtocol(header: string | null | undefined): boolean {
  return (header ?? '').split(',').some((p) => p.trim() === WHARF_SOCKET_PROTOCOL);
}
