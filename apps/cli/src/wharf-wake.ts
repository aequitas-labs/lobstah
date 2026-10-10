import WebSocket from 'ws';
import type { BackendLocation } from '@lobstah/core';

/** Optional hint only. No cursor advancement, worker use, or server heartbeat. */
export class WharfWake {
  private socket?: WebSocket;
  private stopped = false;
  private pending = false;
  private nextAttempt = 0;
  private finish?: () => void;
  constructor(private location: BackendLocation, private credential: string) {}
  private connect() {
    if (this.stopped || this.socket || Date.now() < this.nextAttempt) return;
    this.nextAttempt = Date.now() + 5000;
    const url = new URL(`${this.location.url}/v1/accounts/${encodeURIComponent(this.location.account)}/wake`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.credential}` }, followRedirects: false, handshakeTimeout: 5000, maxPayload: 64 });
    this.socket = socket;
    const wake = () => { this.pending = true; this.finish?.(); };
    socket.on('open', wake); // Catch up even if an event preceded connection.
    socket.on('message', (value) => { if (value.toString() === '{"type":"wake"}') wake(); });
    socket.on('error', () => { /* Polling remains the guarantee; no credential logs. */ });
    socket.on('close', () => { if (this.socket === socket) this.socket = undefined; wake(); });
  }
  wait(milliseconds: number): Promise<void> {
    this.connect();
    if (this.pending || this.stopped) { this.pending = false; return Promise.resolve(); }
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.finish = undefined; this.pending = false; resolve(); };
      const timer = setTimeout(finish, milliseconds);
      this.finish = finish;
    });
  }
  close() { this.stopped = true; this.finish?.(); this.socket?.terminate(); this.socket = undefined; }
}
