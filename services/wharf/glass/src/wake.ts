import { PING_TEXT, SOCKET_PING_MS, WHARF_SOCKET_PROTOCOL } from '../../../../packages/core/src/wharf-socket.js';

/**
 * The page's socket to its account (lobstah.2), cookie scoped. Each pushed
 * `event` message refreshes the page; the page's own poll still runs until
 * it reads from the socket alone. A ping every SOCKET_PING_MS keeps the
 * connection open; the wharf's runtime answers it without waking the account.
 */
export function glassWake(refresh: () => void) {
  let socket: WebSocket | undefined, stopped = false, pinger: ReturnType<typeof setInterval> | undefined;
  const stopPing = () => { if (pinger !== undefined) clearInterval(pinger); pinger = undefined; };
  const connect = () => {
    if (stopped || socket || typeof WebSocket === 'undefined') return;
    const url = new URL('/api/glass/wake', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(url, WHARF_SOCKET_PROTOCOL);
    socket = current;
    current.onopen = () => {
      // Close the connection/subscription gap by reading.
      refresh();
      stopPing();
      pinger = setInterval(() => { if (current.readyState === OPEN) current.send(PING_TEXT); }, SOCKET_PING_MS);
    };
    current.onmessage = (e) => { if (isEvent(e.data)) refresh(); };
    current.onerror = () => { /* The page's poll still runs. */ };
    current.onclose = () => { if (socket === current) { socket = undefined; stopPing(); } };
  };
  return {
    connect,
    close() {
      stopped = true; stopPing();
      if (socket) { socket.onopen = socket.onmessage = socket.onclose = null; socket.close(); }
      socket = undefined;
    },
  };
}

/** WebSocket.OPEN, as a number: the page reads it before any socket class is loaded. */
const OPEN = 1;

/** Whether a message from the wharf is pushed events. */
function isEvent(data: unknown): boolean {
  if (typeof data !== 'string' || data === 'pong') return false;
  try { return (JSON.parse(data) as { t?: unknown }).t === 'event'; } catch { return false; }
}
