import { env, SELF, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { LEASE_MS } from '../src/protocol.js';
import { MINIMUM_SOCKET_CLIENT, WHARF_SOCKET_PROTOCOL } from '../../../packages/core/src/wharf-socket.js';
import type { ServerSocketMessage } from '../../../packages/core/src/wharf-socket.js';
import { authFixtures } from './auth-fixture.js';

/**
 * The account's socket protocol (lobstah.2): resume after hibernation, pings
 * the runtime answers, commands applied once, pushes, and the one alarm that
 * observes what comes due with no request.
 */

const ACCOUNT = 'socket';
let sequence = 0;
const stub = () => env.ACCOUNTS.getByName(ACCOUNT);
const api = (path: string, body?: unknown, token = 'test-helm-a') => SELF.fetch(`https://state.test/v1/accounts/${ACCOUNT}/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `socket-${++sequence}`, 'X-Lobstah-Helm': 'helm' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/** A command as the helm (a private fixture), straight to the object. */
const command = async (path: string, body?: unknown) => JSON.parse(await stub().handle(JSON.stringify({ account: ACCOUNT, helm: true, personId: 'a', token: 'test-helm-a',
  method: body === undefined ? 'GET' : 'POST', path, body: body ?? {}, key: `socket-${++sequence}`, session: 'helm' }))) as { status: number; value: unknown };
async function boat(permissions = ['work', 'helm']) {
  const result = await command('boats', { name: `boat-${++sequence}`, permissions });
  expect(result.status).toBe(201); return result.value as { id: string; token: string };
}
const upgrade = (token: string, protocol: string | null = WHARF_SOCKET_PROTOCOL) => SELF.fetch(`https://state.test/v1/accounts/${ACCOUNT}/wake`, {
  headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}`, ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}) },
});

/** An open socket and every message it has received, in order. */
type Client = { socket: WebSocket; received: string[]; closed: Promise<CloseEvent> };
async function connect(token: string): Promise<Client> {
  const r = await upgrade(token); expect(r.status).toBe(101);
  expect(r.headers.get('Sec-WebSocket-Protocol')).toBe(WHARF_SOCKET_PROTOCOL);
  const socket = r.webSocket!; socket.accept();
  const received: string[] = [];
  socket.addEventListener('message', (e) => received.push(String(e.data)));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve, { once: true }));
  return { socket, received, closed };
}
/** Wait until a received message matches, and return it. */
async function next<T extends ServerSocketMessage['t']>(client: Client, t: T, match: (m: Extract<ServerSocketMessage, { t: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerSocketMessage, { t: T }>> {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const text of client.received) {
      if (text === 'pong') continue;
      const m = JSON.parse(text) as ServerSocketMessage;
      if (m.t === t && match(m as Extract<ServerSocketMessage, { t: T }>)) return m as Extract<ServerSocketMessage, { t: T }>;
    }
    if (Date.now() > deadline) throw new Error(`no ${t} message; got ${JSON.stringify(client.received)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const kinds = (client: Client) => client.received.filter((t) => t !== 'pong').map((t) => JSON.parse(t) as ServerSocketMessage)
  .flatMap((m) => (m.t === 'event' ? m.events.map((e) => e.kind) : []));

beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(stub(), async (instance: Account, state) => {
    for (const socket of state.getWebSockets()) socket.close();
    for (const table of ['boats', 'boat_permissions', 'workers', 'configured_workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'claims', 'catch_context']) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key!='generation'");
    (instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
    (instance as unknown as { pushedSeq: number }).pushedSeq = 0;
    await state.storage.deleteAlarm();
  });
});

it('refuses an upgrade without lobstah.2 with 426 and the minimum client version', async () => {
  const b = await boat();
  const r = await upgrade(b.token, null);
  expect(r.status).toBe(426);
  expect(await r.json()).toMatchObject({ minimumClient: MINIMUM_SOCKET_CLIENT });
  // Read each refusal's body: an unread one holds the request open.
  const older = await upgrade(b.token, 'lobstah.1');
  expect(older.status).toBe(426); await older.text();
});

it('resumes after hibernation: every event after the cursor, then hello with the newest cursor', async () => {
  const b = await boat(); const client = await connect(b.token);
  client.socket.send(JSON.stringify({ t: 'resume' }));
  const start = await next(client, 'hello');
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  expect((await command('dispatches', { id: 'missed', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'resume me' })).status).toBe(200);
  await evictDurableObject(stub(), { webSockets: 'hibernate' });
  expect(client.socket.readyState).toBe(WebSocket.OPEN);
  client.received.length = 0;
  client.socket.send(JSON.stringify({ t: 'resume', after: start.cursor }));
  const hello = await next(client, 'hello');
  const replayed = client.received.map((t) => JSON.parse(t) as ServerSocketMessage).filter((m) => m.t === 'event');
  // Every event after the cursor, in order: the helm, the queued work, and that no worker serves it yet.
  expect(replayed.flatMap((m) => (m.t === 'event' ? m.events.map((e) => e.kind) : []))).toEqual(['helm-taken', 'queued', 'unservable']);
  // hello comes after the events, at the newest event's cursor.
  expect(client.received.at(-1)).toContain('"t":"hello"');
  const last = replayed.at(-1);
  expect(last?.t === 'event' ? last.cursor : undefined).toBe(hello.cursor);
  client.socket.close();
}, 20_000);

it('answers ping with pong from the runtime, without running the object', async () => {
  const b = await boat(); const client = await connect(b.token);
  await evictDurableObject(stub(), { webSockets: 'hibernate' });
  client.socket.send('ping');
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => (client.received.includes('pong') ? resolve() : Date.now() > deadline ? reject(new Error('no pong')) : setTimeout(check, 10));
    check();
  });
  // The runtime records when it auto-answered: the ping never reached webSocketMessage.
  expect(await runInDurableObject(stub(), (_instance: Account, state) => state.getWebSocketAutoResponseTimestamp(state.getWebSockets()[0]!))).not.toBeNull();
  client.socket.close();
}, 20_000);

it('applies a command sent twice with one id once, and answers both times with the same result', async () => {
  const b = await boat(); const client = await connect(b.token);
  const signOn = { t: 'command', id: 'sign-on-1', method: 'POST', path: 'workers/sign-on', body: { worker: 'w1', repo: 'repo', repoRemote: 'github.com/test/repo' } };
  client.socket.send(JSON.stringify(signOn));
  const first = await next(client, 'result', (m) => m.id === 'sign-on-1');
  client.received.length = 0;
  client.socket.send(JSON.stringify(signOn));
  const second = await next(client, 'result', (m) => m.id === 'sign-on-1');
  expect(first.status).toBe(200);
  expect(second).toEqual(first);
  const counted = await runInDurableObject(stub(), (_instance: Account, state) => ({
    workers: state.storage.sql.exec("SELECT count(*) AS n FROM workers WHERE id='w1'").one().n,
    signOns: state.storage.sql.exec("SELECT count(*) AS n FROM events WHERE kind='worker-signed-on'").one().n,
  }));
  expect(counted).toEqual({ workers: 1, signOns: 1 });
  // Claims mint a credential: they stay HTTP.
  client.socket.send(JSON.stringify({ t: 'command', id: 'claim-1', method: 'POST', path: 'claims', body: { worker: 'w1' } }));
  expect((await next(client, 'result', (m) => m.id === 'claim-1')).status).toBe(400);
  client.socket.close();
});

it('requeues a claimed dispatch when its lease passes with no request, and pushes the event', async () => {
  const b = await boat(); const client = await connect(b.token);
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  expect((await api('workers/sign-on', { worker: 'w1', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token)).status).toBe(200);
  expect((await command('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' })).status).toBe(200);
  expect((await api('claims', { worker: 'w1' }, b.token)).status).toBe(200);
  const { lease, alarm } = await runInDurableObject(stub(), async (_instance: Account, state) => ({
    lease: state.storage.sql.exec<{ lease: number }>("SELECT lease FROM dispatches WHERE id='job'").one().lease, alarm: await state.storage.getAlarm(),
  }));
  // The alarm is set for the lease's end itself.
  expect(alarm).toBe(lease);
  // The lease passes: no boat renews, nobody reads.
  await runInDurableObject(stub(), (_instance: Account, state) => {
    state.storage.sql.exec("UPDATE dispatches SET lease=? WHERE id='job'", Date.now() - 1);
    state.storage.sql.exec("UPDATE workers SET seen=? WHERE id='w1'", Date.now() - LEASE_MS - 1);
  });
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  expect(await runInDurableObject(stub(), (_instance: Account, state) => state.storage.sql.exec<{ state: string }>("SELECT state FROM dispatches WHERE id='job'").one().state)).toBe('queued');
  await next(client, 'event', (m) => m.events.some((e) => e.kind === 'lease-lost' && e.dispatchId === 'job'));
  client.socket.close();
});

it('sets no alarm while nothing is due, and removes it when the due thing goes', async () => {
  const b = await boat();
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  const alarm = () => runInDurableObject(stub(), (_instance: Account, state) => state.storage.getAlarm());
  expect(await alarm()).toBeNull();
  // Untargeted work and a live worker: the worker going stale is due.
  expect((await api('workers/sign-on', { worker: 'w1', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token)).status).toBe(200);
  expect((await command('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' })).status).toBe(200);
  expect(await alarm()).not.toBeNull();
  // The work is cancelled: nothing is due any more.
  expect((await command('dispatches/job/cancel', {})).status).toBe(200);
  expect(await alarm()).toBeNull();
});

it('closes a revoked boat’s socket with 1008 before sending it anything more', async () => {
  const b = await boat(); const client = await connect(b.token);
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  await next(client, 'event', (m) => m.events.some((e) => e.kind === 'helm-taken'));
  const before = kinds(client).length;
  expect((await command(`boats/${b.id}/revoke`, {})).status).toBe(200);
  const closed = await client.closed;
  expect(closed.code).toBe(1008);
  // The revocation's own event never reached the revoked boat.
  expect(kinds(client)).toHaveLength(before);
});

it('lets a work-only boat listen for work, showing it each event without its note', async () => {
  const b = await boat(['work']); const client = await connect(b.token);
  client.socket.send(JSON.stringify({ t: 'resume' }));
  await next(client, 'hello');
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  expect((await command('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' })).status).toBe(200);
  expect((await command('dispatches/job/cancel', {})).status).toBe(200);
  const cancelled = await next(client, 'event', (m) => m.events.some((e) => e.kind === 'cancelled'));
  expect(cancelled.events.find((e) => e.kind === 'cancelled')).toEqual({ cursor: expect.any(String), kind: 'cancelled', dispatchId: 'job', at: expect.any(String) });
  // A boat with read sees the same event with its note.
  const reader = await boat(['read']); const watching = await connect(reader.token);
  watching.socket.send(JSON.stringify({ t: 'resume', after: '0.0' }));
  await next(watching, 'hello');
  watching.received.length = 0;
  watching.socket.send(JSON.stringify({ t: 'resume', after: cancelled.events[0]!.cursor.replace(/\.\d+$/, '.0') }));
  const full = await next(watching, 'event', (m) => m.events.some((e) => e.kind === 'cancelled'));
  expect(full.events.find((e) => e.kind === 'cancelled')?.note).toMatch(/^cancelled by /);
  client.socket.close(); watching.socket.close();
});

it('keeps a claim’s lease while its boat renews over the socket, with no HTTP request', async () => {
  const b = await boat(); const client = await connect(b.token);
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  expect((await api('workers/sign-on', { worker: 'w1', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token)).status).toBe(200);
  expect((await command('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' })).status).toBe(200);
  expect((await api('claims', { worker: 'w1' }, b.token)).status).toBe(200);
  await runInDurableObject(stub(), (_instance: Account, state) => { state.storage.sql.exec("UPDATE dispatches SET lease=? WHERE id='job'", Date.now() + 1000); });
  client.socket.send(JSON.stringify({ t: 'command', id: 'renew-1', method: 'POST', path: 'workers/renew', body: { worker: 'w1' } }));
  expect(await next(client, 'result', (m) => m.id === 'renew-1')).toMatchObject({ status: 200 });
  const lease = await runInDurableObject(stub(), (_instance: Account, state) => state.storage.sql.exec<{ lease: number }>("SELECT lease FROM dispatches WHERE id='job'").one().lease);
  expect(lease).toBeGreaterThan(Date.now() + LEASE_MS - 5000);
  client.socket.close();
});

it('answers a boat’s read of its own grants on the socket, and keeps the other private routes HTTP', async () => {
  const b = await boat(['work']); const client = await connect(b.token);
  client.socket.send(JSON.stringify({ t: 'command', id: 'own', method: 'GET', path: '_boat' }));
  expect(await next(client, 'result', (m) => m.id === 'own')).toMatchObject({ status: 200, value: { id: b.id, permissions: ['work'] } });
  client.socket.send(JSON.stringify({ t: 'command', id: 'claim', method: 'POST', path: '_claim', body: {} }));
  expect(await next(client, 'result', (m) => m.id === 'claim')).toMatchObject({ status: 400 });
  client.socket.close();
});
