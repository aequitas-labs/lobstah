import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { WharfSocket } from '../src/wharf-socket.js';

/**
 * The boat's and the helm's socket to the wharf: lobstah.2 with the bearer
 * in the header only, resume from the last cursor after a drop, a `wait`
 * that ends on the kinds asked for, and no throw when the wharf is away.
 */

type Seen = { socket: ServerSocket; authorization?: string; protocol?: string; url?: string; messages: string[] };
let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

async function wharf(): Promise<{ url: string; seen: Seen[] }> {
  const server = createServer();
  const ws = new WebSocketServer({ server, handleProtocols: (offered) => (offered.has('lobstah.2') ? 'lobstah.2' : false) });
  const seen: Seen[] = [];
  ws.on('connection', (socket, request) => {
    const s: Seen = { socket, authorization: request.headers.authorization, protocol: socket.protocol, url: request.url, messages: [] };
    socket.on('message', (data) => s.messages.push(data.toString()));
    seen.push(s);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = async () => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const until = async (check: () => boolean, ms = 3000) => {
  for (const deadline = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > deadline) throw new Error('timed out');
};

it('asks for lobstah.2 with the bearer in the header, resumes, and resumes again from its cursor after a drop', async () => {
  const w = await wharf();
  const heard: string[] = [];
  const socket = new WharfSocket({ url: w.url, account: 'a', tokenEnv: 'TEST' }, 'secret', { client: '0.8.10', onMessage: (m) => heard.push(m.t), random: () => 0 });
  try {
    socket.start();
    await until(() => w.seen[0]?.messages.length === 1);
    expect(w.seen[0]).toMatchObject({ authorization: 'Bearer secret', protocol: 'lobstah.2', url: '/v1/accounts/a/wake' });
    expect(JSON.parse(w.seen[0]!.messages[0]!)).toEqual({ t: 'resume', client: '0.8.10' });
    w.seen[0]!.socket.send(JSON.stringify({ t: 'event', events: [{ cursor: 'g.4', kind: 'queued', at: '2026-11-12T00:00:00Z' }], cursor: 'g.4' }));
    await until(() => heard.includes('event'));
    // The wharf drops the socket: the client comes back and resumes after the last event it had.
    w.seen[0]!.socket.terminate();
    await until(() => w.seen[1]?.messages.length === 1, 5000);
    expect(JSON.parse(w.seen[1]!.messages[0]!)).toEqual({ t: 'resume', after: 'g.4', client: '0.8.10' });
    expect(socket.send({ t: 'attention', attention: [] })).toBe(true);
    await until(() => w.seen[1]!.messages.length === 2);
  } finally { socket.close(); }
});

it('ends a wait when a message of the asked kind arrives, and keeps one that came between waits', async () => {
  const w = await wharf();
  const socket = new WharfSocket({ url: w.url, account: 'a', tokenEnv: 'TEST' }, 'secret', { kinds: ['event'] });
  try {
    await socket.wait(1000); // opens the socket; its open ends the first wait
    await until(() => w.seen.length === 1);
    w.seen[0]!.socket.send(JSON.stringify({ t: 'event', events: [], cursor: 'g.1' }));
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await socket.wait(2000);
    expect(Date.now() - started).toBeLessThan(500);
    expect(socket.heard('event')).toBe(true);
    expect(socket.heard('event')).toBe(false);
  } finally { socket.close(); }
});

it('does not throw or hold a wait when the wharf is away', async () => {
  const socket = new WharfSocket({ url: 'http://127.0.0.1:1', account: 'a', tokenEnv: 'TEST' }, 'secret');
  try {
    await socket.wait(20);
    expect(socket.connected()).toBe(false);
    expect(socket.send({ t: 'resume' })).toBe(false);
  } finally { socket.close(); }
});

it('recovers from ECONNRESET and reloads the saved credential before reconnecting', async () => {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const credentials: Array<string | undefined> = [];
  server.on('upgrade', (request, socket, head) => {
    credentials.push(request.headers.authorization);
    if (credentials.length === 1) return void socket.destroy();
    ws.handleUpgrade(request, socket, head, () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const errors: Array<string | undefined> = [];
  let credential = 'old-test-token';
  const socket = new WharfSocket({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, account: 'a', tokenEnv: 'TEST' }, () => credential,
    { random: () => 0, onError: error => { errors.push((error as NodeJS.ErrnoException).code); credential = 'new-test-token'; } });
  try {
    socket.start();
    await until(() => socket.connected(), 5000);
    expect(errors).toContain('ECONNRESET');
    expect(credentials).toEqual(['Bearer old-test-token', 'Bearer new-test-token']);
  } finally {
    socket.close();
    for (const client of ws.clients) client.terminate();
    ws.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('keeps retrying when the boat credential is missing and connects after login', async () => {
  const w = await wharf();
  let credential = '';
  const errors: string[] = [];
  const socket = new WharfSocket({ url: w.url, account: 'a', tokenEnv: 'TEST' }, () => credential,
    { random: () => 0, onError: error => errors.push(error.message) });
  try {
    socket.start();
    expect(errors).toEqual([expect.stringContaining('credential is missing')]);
    expect(w.seen).toEqual([]);
    credential = 'new-test-token';
    await until(() => socket.connected(), 5000);
    expect(w.seen[0]?.authorization).toBe('Bearer new-test-token');
  } finally { socket.close(); }
});
