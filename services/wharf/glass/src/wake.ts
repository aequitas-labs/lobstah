/** Optional browser hint. Cookie scoped, no commands/content, no server pings. */
export function glassWake(refresh: () => void) {
  let socket: WebSocket | undefined, stopped = false;
  const connect = () => {
    if (stopped || socket || typeof WebSocket === 'undefined') return;
    const url = new URL('/api/glass/wake', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(url);
    socket = current;
    current.onopen = refresh; // Close the connection/subscription gap by reading.
    current.onmessage = (e) => { if (e.data === '{"type":"wake"}') refresh(); };
    current.onerror = () => { /* The existing fifteen-second poll still runs. */ };
    current.onclose = () => { if (socket === current) socket = undefined; };
  };
  return { connect, close() { stopped = true; if (socket) { socket.onopen = socket.onmessage = socket.onclose = null; socket.close(); } socket = undefined; } };
}
