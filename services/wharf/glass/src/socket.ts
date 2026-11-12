import { PING_TEXT, PONG_TEXT, SOCKET_PING_MS, WHARF_SOCKET_PROTOCOL, decodeFrame } from '../../../../packages/core/src/wharf-socket.js';
import type { ServerSocketMessage } from '../../../../packages/core/src/wharf-socket.js';
import type { MirrorAnswer, MirrorCall, PushedSnapshot } from '../../../../packages/glass-ui/ui/backends/mirror.js';

/**
 * The page's socket to its account (lobstah.2), cookie scoped: the page's
 * only live channel. Pushed events make the page read again; a boat's new
 * snapshot arrives as its gzip bytes and shows with no request; relayed
 * calls go out on it and their answers come back on it. While it is open the
 * page polls on no timer (`live`). A ping every SOCKET_PING_MS keeps it open;
 * the wharf's runtime answers it without waking the account. A tab hidden
 * for HIDDEN_CLOSE_MS closes its socket, so a forgotten tab stops watching,
 * and opens it again when shown.
 */

/** How long a hidden tab keeps its socket. */
export const HIDDEN_CLOSE_MS = 60_000;

/** What the page does with what the socket brings. */
export interface GlassSocketHandlers {
  /** The socket opened (true) or closed (false). */
  live(open: boolean): void;
  /** Events were pushed, or the socket opened after a gap: read the page again. */
  refresh(): void;
  /** A boat's new snapshot. */
  snapshot(pushed: PushedSnapshot): void;
}

export interface GlassSocket {
  /** Open the socket, unless it is open, closed for good, or the tab is hidden. */
  connect(): void;
  /** Close it for good: the person signed out. */
  close(): void;
  /** Whether it is open now. */
  connected(): boolean;
  /** Send one relayed call; the boat's answer, or undefined when none came within `waitMs`. */
  call(call: MirrorCall, waitMs: number): Promise<MirrorAnswer | undefined>;
}

/** WebSocket.OPEN, as a number: the page reads it before any socket class is loaded. */
const OPEN = 1;

export function glassSocket(handlers: GlassSocketHandlers): GlassSocket {
  let socket: WebSocket | undefined;
  let stopped = false;
  let cursor: string | undefined;
  let pinger: ReturnType<typeof setInterval> | undefined;
  let hiding: ReturnType<typeof setTimeout> | undefined;
  /** Calls sent and not yet answered, by id. */
  const waiting = new Map<string, (answer: MirrorAnswer | undefined) => void>();

  const settle = (id: string, answer: MirrorAnswer | undefined) => {
    const resolve = waiting.get(id);
    waiting.delete(id);
    resolve?.(answer);
  };
  const stopPing = () => {
    if (pinger !== undefined) clearInterval(pinger);
    pinger = undefined;
  };
  const dropped = (current: WebSocket) => {
    if (socket !== current) return;
    socket = undefined;
    stopPing();
    for (const id of [...waiting.keys()]) settle(id, undefined);
    handlers.live(false);
  };

  const onText = (text: string) => {
    if (text === PONG_TEXT) return;
    let message: ServerSocketMessage;
    try {
      message = JSON.parse(text) as ServerSocketMessage;
    } catch {
      return;
    }
    if (message.t === 'event') {
      cursor = message.cursor;
      handlers.refresh();
    } else if (message.t === 'hello') cursor = message.cursor;
    else if (message.t === 'result' && message.status !== 202 && waiting.has(message.id)) {
      // The wharf refused the call before any boat saw it.
      settle(message.id, { status: message.status, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(message.value)) });
    }
  };

  const onBinary = async (data: ArrayBuffer) => {
    const frame = decodeFrame(data);
    if (!frame) return;
    const { header, payload } = frame;
    if (header.t === 'answer') {
      settle(header.id, { status: header.status, contentType: header.contentType, body: payload, ...(header.large ? { large: true as const } : {}) });
      return;
    }
    const json = await new Response(new Blob([payload as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    handlers.snapshot({ boat: header.boat, name: header.name, at: header.at, etag: header.etag, json });
  };

  const connect = () => {
    if (stopped || socket || typeof WebSocket === 'undefined' || (typeof document !== 'undefined' && document.hidden)) return;
    const url = new URL('/api/glass/wake', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(url, WHARF_SOCKET_PROTOCOL);
    current.binaryType = 'arraybuffer';
    socket = current;
    current.onopen = () => {
      current.send(JSON.stringify(cursor ? { t: 'resume', after: cursor } : { t: 'resume' }));
      handlers.live(true);
      // Read once: whatever changed while the socket was down shows now.
      handlers.refresh();
      stopPing();
      pinger = setInterval(() => {
        if (current.readyState === OPEN) current.send(PING_TEXT);
      }, SOCKET_PING_MS);
    };
    current.onmessage = (e) => {
      // Binary frames come as ArrayBuffers (binaryType above); anything not text is a frame.
      if (typeof e.data === 'string') onText(e.data);
      else void onBinary(e.data as ArrayBuffer);
    };
    current.onerror = () => {
      /* onclose follows: the page polls again until the socket is back. */
    };
    current.onclose = () => dropped(current);
  };

  const visibility = () => {
    if (hiding !== undefined) clearTimeout(hiding);
    hiding = undefined;
    if (!document.hidden) connect();
    else
      hiding = setTimeout(() => {
        const current = socket;
        if (current && document.hidden) {
          current.close(1000, 'tab hidden');
          dropped(current);
        }
      }, HIDDEN_CLOSE_MS);
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);

  return {
    connect,
    close() {
      stopped = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
      if (hiding !== undefined) clearTimeout(hiding);
      const current = socket;
      if (current) {
        current.onopen = current.onmessage = current.onclose = null;
        current.close();
        dropped(current);
      }
    },
    connected: () => socket?.readyState === OPEN,
    call(call, waitMs) {
      const current = socket;
      if (!current || current.readyState !== OPEN) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(call.id, undefined), waitMs);
        waiting.set(call.id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        current.send(JSON.stringify({ t: 'call', ...call }));
      });
    },
  };
}
