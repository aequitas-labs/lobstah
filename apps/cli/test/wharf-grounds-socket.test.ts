import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backendScope, ensureLayout, loadConfig, readHostedViews, refreshHostedViews } from '@lobstah/core';
import { wharfCommand } from '../src/wharf-commands.js';
import { closeChannels, eventTopics, hostedRefresh, openChannel } from '../src/wharf-channel.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A wharf-grounds boat and a waiting helm on the wharf's socket: they learn
 * of work from pushed events, send their renewals on the socket, and read
 * over HTTP only what an event said changed.
 */

type Wharf = { url: string; sockets: ServerSocket[]; messages: Array<Record<string, unknown>>; http: string[]; push: (message: unknown) => void };
let home: string;
let stop: () => Promise<void> = async () => {};

/** A wharf on loopback: it answers every command on the socket with 200, and every HTTP request from `routes`. */
async function wharf(routes: Record<string, unknown> = {}): Promise<Wharf> {
  const http: string[] = [], messages: Array<Record<string, unknown>> = [], sockets: ServerSocket[] = [];
  const server = createServer((request, response) => {
    const route = `${request.method} ${new URL(request.url!, 'http://x').pathname.replace(/^\/v1\/accounts\/[^/]+\//, '')}`;
    http.push(route);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(routes[route] ?? {}));
  });
  const ws = new WebSocketServer({ server, handleProtocols: (offered) => (offered.has('lobstah.2') ? 'lobstah.2' : false) });
  ws.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const text = data.toString();
      if (text === 'ping') return void socket.send('pong');
      const m = JSON.parse(text) as Record<string, unknown>;
      messages.push(m);
      if (m.t === 'resume') socket.send(JSON.stringify({ t: 'hello', protocol: 'lobstah.2', cursor: (m.after as string | undefined) ?? 'g.1' }));
      if (m.t === 'command') socket.send(JSON.stringify({ t: 'result', id: m.id, status: 200, value: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stop = async () => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const push = (message: unknown) => { for (const s of sockets) s.send(JSON.stringify(message)); };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets, messages, http, push };
}
const until = async (check: () => boolean, ms = 3000) => {
  for (const deadline = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > deadline) throw new Error('timed out');
};
function configure(url: string) {
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.remote]
path = '${home.replaceAll('\\', '/')}'
[wharves.cloud]
url = '${url}'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_SOCKET_TOKEN'
[grounds.away]
repos = ['remote']
wharf = 'cloud'
`);
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-grounds-socket-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  process.env.LOBSTAH_TEST_SOCKET_TOKEN = 'b.person.boat-1.secret';
});
afterEach(async () => {
  closeChannels(); vi.restoreAllMocks(); await stop();
  delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_TEST_SOCKET_TOKEN; removeTempDir(home);
});

it('man wait ends on a pushed event, renews the helm on the socket, and sends no GET events', async () => {
  const w = await wharf(); configure(w.url);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--session': 'helm', '--after': 'g.7', '--timeout': '20' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  const waiting = wharfCommand('man:wait', [], opts, loadConfig());
  await until(() => w.messages.some((m) => m.t === 'resume'));
  expect(w.messages.find((m) => m.t === 'resume')).toMatchObject({ after: 'g.7' });
  const event = { cursor: 'g.8', kind: 'decision-answer', at: new Date().toISOString() };
  w.push({ t: 'event', events: [event], cursor: 'g.8' });
  await waiting;
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({ events: [event], cursor: 'g.8' });
  expect(w.messages).toContainEqual(expect.objectContaining({ t: 'command', method: 'POST', path: 'helm/renew', session: 'helm' }));
  expect(w.http).toEqual([]);
});

it('man wait with no event reads nothing over HTTP until it times out', async () => {
  const w = await wharf(); configure(w.url);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--session': 'helm', '--after': 'g.7', '--timeout': '1' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  await wharfCommand('man:wait', [], opts, loadConfig());
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({ cursor: 'g.7', timeout: true });
  expect(w.http.filter((r) => r.startsWith('GET events'))).toEqual([]);
});

it('the boat reads its jobs once, then again only when an event names a job; an open socket keeps the view current', async () => {
  const w = await wharf({ 'GET dispatches': [], 'GET documents': [] }); configure(w.url);
  const scope = backendScope(loadConfig(), 'away');
  if (scope.kind !== 'wharf') throw new Error('wharf grounds expected');
  const channel = openChannel(scope)!;
  await until(() => channel.connected() && w.messages.some((m) => m.t === 'resume'));
  const refresh = hostedRefresh();
  await refreshHostedViews(loadConfig(), refresh);
  const first = w.http.length;
  // Jobs and documents over HTTP; the usage reads went on the socket.
  expect(w.http).toEqual(['GET dispatches', 'GET documents']);
  expect(w.messages).toContainEqual(expect.objectContaining({ t: 'command', method: 'GET', path: '_boat' }));
  // Ten quiet refreshes: no request, and the view stays current.
  for (let i = 0; i < 10; i++) await refreshHostedViews(loadConfig(), refresh);
  expect(w.http.length).toBe(first);
  expect(readHostedViews(loadConfig())[0]).not.toHaveProperty('unavailable');
  // A reader that has asked once: it comes due again when the event lands.
  channel.due('claim', 'probe');
  w.push({ t: 'event', events: [{ cursor: 'g.2', kind: 'queued', dispatchId: 'job', at: new Date().toISOString() }], cursor: 'g.2' });
  await until(() => channel.due('claim', 'probe'));
  await refreshHostedViews(loadConfig(), refresh);
  expect(w.http.slice(first)).toEqual(['GET dispatches']);
});

it('maps each event to the reads it calls for', () => {
  expect(eventTopics({ kind: 'queued', dispatchId: 'j' })).toEqual(['dispatches', 'claim']);
  expect(eventTopics({ kind: 'message', dispatchId: 'j' })).toEqual(['dispatches', 'messages:j']);
  expect(eventTopics({ kind: 'cancelled', dispatchId: 'j' })).toEqual(['dispatches', 'job:j']);
  expect(eventTopics({ kind: 'lease-lost', dispatchId: 'j' })).toEqual(['dispatches', 'claim', 'job:j']);
  expect(eventTopics({ kind: 'trap-start-authorized' })).toEqual(['starts']);
  expect(eventTopics({ kind: 'decision', dispatchId: 'j' })).toEqual(['dispatches', 'documents']);
  expect(eventTopics({ kind: 'helm-taken' })).toEqual([]);
});

it('reads card answers once, then only on the wharf’s nudge, and restates cards on the socket', async () => {
  const w = await wharf({ 'GET cards/answers': [] }); configure(w.url);
  const scope = backendScope(loadConfig(), 'away');
  if (scope.kind !== 'wharf') throw new Error('wharf grounds expected');
  const channel = openChannel(scope)!;
  await until(() => channel.connected());
  const { publishBoatCards } = await import('../src/wharf-cards.js');
  let now = Date.now();
  await publishBoatCards(now);
  expect(w.http).toEqual(['GET cards/answers']);
  // The boat's (empty) set went on the socket.
  expect(w.messages).toContainEqual(expect.objectContaining({ t: 'command', method: 'POST', path: 'cards', body: { cards: [] } }));
  for (let i = 0; i < 5; i++) { now += 60_000; await publishBoatCards(now); }
  expect(w.http).toEqual(['GET cards/answers']);
  channel.due('answers', 'probe');
  w.push({ t: 'nudge', read: 'cards/answers' });
  await until(() => channel.due('answers', 'probe'));
  await publishBoatCards(now + 1);
  expect(w.http).toEqual(['GET cards/answers', 'GET cards/answers']);
});
