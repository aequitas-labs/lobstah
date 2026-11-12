import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { mirrorTables } from '../src/mirror-state.js';
import { authFixtures } from './auth-fixture.js';
import { MINIMUM_SOCKET_CLIENT } from '../../../packages/core/src/wharf-socket.js';
import type { ServerSocketMessage } from '../../../packages/core/src/wharf-socket.js';

/**
 * Attention lists, on the boats' sockets: each mirror boat sends the items
 * its pet walks when they change, and a boat granted `attention` gets every
 * other boat's list pushed, so its pet walks them too. An ack of another
 * boat's item is relayed to that boat as one attention-ack call, pushed to
 * its socket.
 */

const ACCOUNT = 'attention';
let sequence = 0;
const stub = () => env.ACCOUNTS.getByName(ACCOUNT);
const command = async (path: string, body?: unknown) => JSON.parse(await stub().handle(JSON.stringify({ account: ACCOUNT, helm: true, personId: 'a', token: 'test-helm-a',
  method: body === undefined ? 'GET' : 'POST', path, body: body ?? {}, key: `attention-${++sequence}` })));
type Boat = { id: string; token: string };
async function enrol(permissions: string[]): Promise<Boat> {
  const result = await command('boats', { name: `boat-${++sequence}`, permissions });
  expect(result.status, JSON.stringify(result.value)).toBe(201);
  return result.value as Boat;
}
const api = (boat: Boat, path: string, init: { method?: string; body?: unknown } = {}) => SELF.fetch(`https://state.test/v1/accounts/${ACCOUNT}/${path}`, {
  method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
  headers: { Authorization: `Bearer ${boat.token}`, 'Idempotency-Key': `attention-${++sequence}` },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
});
const item = (key: string, note: string) => ({ key, kind: 'question', stateHash: `${key}-1`, id: key, lane: 'work', verb: 'needs-decision', note });

/** A boat's open socket, and every message it has received. */
type BoatSocket = { socket: WebSocket; received: ServerSocketMessage[] };
async function socketOf(boat: Boat): Promise<BoatSocket> {
  const r = await SELF.fetch(`https://state.test/v1/accounts/${ACCOUNT}/wake`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${boat.token}`, 'Sec-WebSocket-Protocol': 'lobstah.2' } });
  expect(r.status).toBe(101);
  const socket = r.webSocket!; socket.accept();
  const received: ServerSocketMessage[] = [];
  socket.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data !== 'pong') received.push(JSON.parse(e.data)); });
  return { socket, received };
}
/** Wait until a message matches; `ms` with none is a timeout. */
async function next(b: BoatSocket, match: (m: ServerSocketMessage) => boolean, ms = 3000): Promise<ServerSocketMessage> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 10))) {
    const found = b.received.find(match);
    if (found) return found;
  }
  throw new Error(`no matching message; got ${JSON.stringify(b.received)}`);
}
const lists = (m: ServerSocketMessage) => (m.t === 'attention' ? m.boats : undefined);
/** Send a boat's list on its socket, and let the wharf take it. */
async function sendList(b: BoatSocket, attention: unknown) {
  b.socket.send(JSON.stringify({ t: 'attention', attention }));
  await new Promise((r) => setTimeout(r, 100));
}

beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(stub(), (_instance: Account, state) => {
    for (const socket of state.getWebSockets()) socket.close();
    for (const table of ['boats', 'boat_permissions', 'idem', ...mirrorTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
    // Request counts live in the instance's memory, not in meta.
    (_instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
  });
});

describe('attention lists', () => {
  it("pushes every other mirror boat's list to a boat granted attention, never its own, and nothing to a boat without the grant", async () => {
    const readerBoat = await enrol(['mirror', 'attention', 'read']);
    const northBoat = await enrol(['mirror', 'read']), southBoat = await enrol(['mirror', 'read']);
    const reader = await socketOf(readerBoat), north = await socketOf(northBoat), south = await socketOf(southBoat);
    await sendList(reader, [item('work:r', 'mine')]);
    await sendList(north, [item('work:n', 'Which port?')]);
    await sendList(south, []);
    const latest = await next(reader, (m) => (lists(m) ?? []).length === 2);
    expect(new Map(lists(latest)!.map((b) => [b.boat, b.attention]))).toEqual(new Map<string, unknown[]>([[northBoat.id, [item('work:n', 'Which port?')]], [southBoat.id, []]]));
    // The reader's own list never comes back to it; a boat without the grant gets no lists.
    expect(reader.received.flatMap((m) => lists(m) ?? []).some((b) => b.boat === readerBoat.id)).toBe(false);
    expect(north.received.some((m) => m.t === 'attention')).toBe(false);
    reader.socket.close(); north.socket.close(); south.socket.close();
  });

  it('passes on a changed list only: an unchanged one is not pushed again', async () => {
    const reader = await socketOf(await enrol(['mirror', 'attention', 'read'])), north = await socketOf(await enrol(['mirror', 'read']));
    await sendList(north, [item('work:n', 'Which port?')]);
    await next(reader, (m) => m.t === 'attention');
    const pushes = () => reader.received.filter((m) => m.t === 'attention').length;
    const before = pushes();
    await sendList(north, [item('work:n', 'Which port?')]);
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes()).toBe(before);
    await sendList(north, []);
    await next(reader, (m) => m.t === 'attention' && pushes() > before);
    reader.socket.close(); north.socket.close();
  });

  it('refuses a list from a boat that does not mirror, and the attention grant without mirror', async () => {
    const north = await enrol(['mirror', 'read']), workerBoat = await enrol(['work', 'read']);
    const worker = await socketOf(workerBoat);
    await sendList(worker, []);
    expect(await next(worker, (m) => m.t === 'error')).toMatchObject({ reason: 'only a mirror boat sends its list' });
    expect((await api(north, 'mirror/attention/acks', { body: { boat: workerBoat.id, key: 'work:x', stateHash: 'h' } })).status).toBe(403);
    expect((await command('boats', { name: 'loose', permissions: ['attention', 'read'] })).status).toBe(400);
    worker.socket.close();
  });

  it('refuses a list that is not a list of items, or too long', async () => {
    const north = await socketOf(await enrol(['mirror', 'read']));
    for (const attention of ['x', [1], Array.from({ length: 501 }, (_, i) => item(`work:${i}`, 'q'))]) {
      north.received.length = 0;
      await sendList(north, attention);
      await next(north, (m) => m.t === 'error');
    }
    north.socket.close();
  });

  it('drops a revoked boat’s list: a reader resuming gets none', async () => {
    const readerBoat = await enrol(['mirror', 'attention', 'read']), northBoat = await enrol(['mirror', 'read']);
    const north = await socketOf(northBoat);
    await sendList(north, [item('work:n', 'Which port?')]);
    expect((await command(`boats/${northBoat.id}/revoke`, {})).status).toBe(200);
    const reader = await socketOf(readerBoat);
    reader.socket.send(JSON.stringify({ t: 'resume' }));
    expect(lists(await next(reader, (m) => m.t === 'attention'))).toEqual([]);
    reader.socket.close();
  });

  it('answers 410 with the minimum client version to the list routes boats used to poll', async () => {
    const north = await enrol(['mirror', 'attention', 'read']);
    for (const r of [await api(north, 'mirror/attention'), await api(north, 'mirror/attention', { method: 'PUT', body: { attention: [] } })]) {
      expect(r.status).toBe(410);
      expect(await r.json()).toMatchObject({ minimumClient: MINIMUM_SOCKET_CLIENT });
    }
  });
});

describe('the attention grant', () => {
  it('stands apart from mirror and the steering layers, and only beside mirror', async () => {
    const { boatPermissions, permits, requiredPermission } = await import('../src/permissions.js');
    expect(boatPermissions(['read', 'attention', 'mirror'], false)).toEqual(['mirror', 'attention', 'read']);
    expect(permits(['mirror', 'attention', 'read'], 'attention')).toBe(true);
    expect(permits(['mirror', 'read'], 'attention')).toBe(false);
    expect(permits(['admin'], 'attention')).toBe(false);
    expect(permits(['mirror', 'attention', 'read'], 'helm')).toBe(false);
    expect(requiredPermission('mirror/attention/acks', 'POST')).toBe('attention');
  });
});

describe('relayed acks', () => {
  it('queues one attention-ack call for the boat that owns the item, and pushes it to that boat', async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), northBoat = await enrol(['mirror', 'read']);
    const north = await socketOf(northBoat);
    const r = await api(reader, 'mirror/attention/acks', { body: { boat: northBoat.id, key: 'work:n', stateHash: 'work:n-1' } });
    expect(r.status, await r.clone().text()).toBe(200);
    const pushed = await next(north, (m) => m.t === 'call');
    expect(pushed).toMatchObject({ t: 'call', call: { boat: northBoat.id, by: reader.id, state: 'queued',
      write: { kind: 'attention-ack', payload: { items: [{ key: 'work:n', stateHash: 'work:n-1' }] } } } });
    north.socket.close();
  });

  it("refuses an ack of the reader's own items, of a boat that does not mirror, and any other field", async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), worker = await enrol(['work', 'read']);
    const ack = (body: unknown) => api(reader, 'mirror/attention/acks', { body });
    expect((await ack({ boat: reader.id, key: 'work:r', stateHash: 'h' })).status).toBe(400);
    expect((await ack({ boat: worker.id, key: 'work:w', stateHash: 'h' })).status).toBe(404);
    expect((await ack({ boat: worker.id, key: 'work:w', stateHash: 'h', write: { kind: 'decision-answer' } })).status).toBe(400);
  });
});
