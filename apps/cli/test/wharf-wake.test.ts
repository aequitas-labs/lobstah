import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { WharfWake } from '../src/wharf-wake.js';

it('uses header-only auth, latches a wake between reads, and falls back after a dropped socket', async () => {
  const server = createServer(); const ws = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const hints = new WharfWake({ url: `http://127.0.0.1:${address.port}`, account: 'a', tokenEnv: 'TEST' }, 'secret');
  try {
    const connection = new Promise<void>((resolve) => ws.once('connection', (socket, request) => {
      expect(request.headers.authorization).toBe('Bearer secret'); expect(request.url).toBe('/v1/accounts/a/wake');
      socket.send('{"type":"wake"}'); resolve();
    }));
    await hints.wait(1000); await connection;
    // Let the message arrive before the next wait: it must not be lost.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const start = Date.now(); await hints.wait(1000); expect(Date.now() - start).toBeLessThan(500);
    for (const socket of ws.clients) socket.terminate();
    await hints.wait(20); await hints.wait(20);
  } finally { hints.close(); ws.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
it('unavailable hints do not throw or prevent the polling deadline', async () => {
  const hints = new WharfWake({ url: 'http://127.0.0.1:1', account: 'a', tokenEnv: 'TEST' }, 'secret');
  try { await hints.wait(20); } finally { hints.close(); }
});
