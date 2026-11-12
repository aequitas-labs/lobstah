import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { mirrorTables } from '../src/mirror-state.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfMirrorCall } from '../../../packages/core/src/backend-model.js';

/**
 * Attention lists: each mirror boat puts the items its pet walks, and a boat
 * granted `attention` reads every other boat's, so its pet walks them too.
 * Reading one never counts as a hosted glass being open. An ack of another
 * boat's item is relayed to that boat as one attention-ack call.
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
async function putList(boat: Boat, attention: unknown[]) {
  const r = await api(boat, 'mirror/attention', { method: 'PUT', body: { attention } });
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json<{ etag: string; at: string; changed: boolean }>();
}
type Listed = { boat: string; name: string; etag: string; at: string; attention?: unknown[]; unchanged?: true };
async function lists(boat: Boat, known = ''): Promise<Listed[]> {
  const r = await api(boat, `mirror/attention${known ? `?known=${encodeURIComponent(known)}` : ''}`);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json<{ boats: Listed[] }>()).boats;
}
function message(socket: WebSocket, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no hint')), ms);
    socket.addEventListener('message', (e) => { clearTimeout(timeout); resolve(String(e.data)); }, { once: true });
  });
}
async function socketOf(boat: Boat): Promise<WebSocket> {
  const r = await SELF.fetch(`https://state.test/v1/accounts/${ACCOUNT}/wake`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${boat.token}`, 'Sec-WebSocket-Protocol': 'lobstah.2' } });
  expect(r.status).toBe(101);
  r.webSocket!.accept();
  return r.webSocket!;
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
  it("reads every other mirror boat's list, never its own, and holds back a list it already has", async () => {
    const reader = await enrol(['mirror', 'attention', 'read']);
    const north = await enrol(['mirror', 'read']), south = await enrol(['mirror', 'read']);
    await putList(reader, [item('work:r', 'mine')]);
    await putList(north, [item('work:n', 'Which port?')]);
    await putList(south, []);
    const first = await lists(reader);
    expect(new Map(first.map((b) => [b.boat, b.attention]))).toEqual(new Map<string, unknown[]>([[north.id, [item('work:n', 'Which port?')]], [south.id, []]]));
    const known = first.map((b) => `${b.boat}:${b.etag}`).join(',');
    expect((await lists(reader, known)).map((b) => [b.boat, b.unchanged, b.attention])).toEqual(first.map((b) => [b.boat, true, undefined]));
  });

  it('keeps an unchanged list as it was, and says when one changed', async () => {
    const north = await enrol(['mirror', 'read']);
    const first = await putList(north, [item('work:n', 'Which port?')]);
    expect(first.changed).toBe(true);
    const again = await putList(north, [item('work:n', 'Which port?')]);
    expect(again).toEqual({ ...first, changed: false });
    expect((await putList(north, [])).changed).toBe(true);
  });

  it('refuses a boat without the attention grant, and the grant without mirror', async () => {
    const north = await enrol(['mirror', 'read']), worker = await enrol(['work', 'read']);
    expect((await api(north, 'mirror/attention')).status).toBe(403);
    expect((await api(north, 'mirror/attention/acks', { body: { boat: worker.id, key: 'work:x', stateHash: 'h' } })).status).toBe(403);
    expect((await api(worker, 'mirror/attention', { method: 'PUT', body: { attention: [] } })).status).toBe(403);
    expect((await command('boats', { name: 'loose', permissions: ['attention', 'read'] })).status).toBe(400);
  });

  it('refuses a list that is not a list of items, or too long', async () => {
    const north = await enrol(['mirror', 'read']);
    expect((await api(north, 'mirror/attention', { method: 'PUT', body: { attention: 'x' } })).status).toBe(400);
    expect((await api(north, 'mirror/attention', { method: 'PUT', body: { attention: [1] } })).status).toBe(400);
    expect((await api(north, 'mirror/attention', { method: 'PUT', body: { attention: Array.from({ length: 501 }, (_, i) => item(`work:${i}`, 'q')) } })).status).toBe(400);
  });

  it('drops a revoked boat’s list', async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), north = await enrol(['mirror', 'read']);
    await putList(north, [item('work:n', 'Which port?')]);
    expect((await command(`boats/${north.id}/revoke`, {})).status).toBe(200);
    expect(await lists(reader)).toEqual([]);
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
    expect(requiredPermission('mirror/attention', 'PUT')).toBe('mirror');
    expect(requiredPermission('mirror/attention', 'GET')).toBe('attention');
    expect(requiredPermission('mirror/attention/acks', 'POST')).toBe('attention');
  });
});

describe('attention hints', () => {
  it('tells the boats granted attention when another boat’s list changed, and nobody when it did not', async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), north = await enrol(['mirror', 'read']);
    const readerSocket = await socketOf(reader), northSocket = await socketOf(north);
    const told = message(readerSocket);
    const putterTold = message(northSocket, 500).then(() => true, () => false);
    await putList(north, [item('work:n', 'Which port?')]);
    expect(await told).toBe('{"type":"attention"}');
    expect(await putterTold).toBe(false);
    const again = message(readerSocket, 500).then(() => true, () => false);
    await putList(north, [item('work:n', 'Which port?')]);
    expect(await again).toBe(false);
    readerSocket.close(); northSocket.close();
  });

  it('never counts a boat’s read as a hosted glass being open', async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), north = await enrol(['mirror', 'read']);
    await lists(reader);
    const calls = await (await api(north, 'mirror/calls')).json<{ watchedUntil?: string }>();
    expect(calls.watchedUntil).toBeUndefined();
  });
});

describe('relayed acks', () => {
  it("queues one attention-ack call for the boat that owns the item, and wakes it", async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), north = await enrol(['mirror', 'read']);
    const northSocket = await socketOf(north);
    const woke = message(northSocket);
    const r = await api(reader, 'mirror/attention/acks', { body: { boat: north.id, key: 'work:n', stateHash: 'work:n-1' } });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await woke).toBe('{"type":"mirror-call"}');
    const { calls } = await (await api(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>();
    expect(calls).toEqual([expect.objectContaining({ boat: north.id, by: reader.id, state: 'queued',
      write: { kind: 'attention-ack', payload: { items: [{ key: 'work:n', stateHash: 'work:n-1' }] } } })]);
    northSocket.close();
  });

  it("refuses an ack of the reader's own items, of a boat that does not mirror, and any other field", async () => {
    const reader = await enrol(['mirror', 'attention', 'read']), worker = await enrol(['work', 'read']);
    const ack = (body: unknown) => api(reader, 'mirror/attention/acks', { body });
    expect((await ack({ boat: reader.id, key: 'work:r', stateHash: 'h' })).status).toBe(400);
    expect((await ack({ boat: worker.id, key: 'work:w', stateHash: 'h' })).status).toBe(404);
    expect((await ack({ boat: worker.id, key: 'work:w', stateHash: 'h', write: { kind: 'decision-answer' } })).status).toBe(400);
  });
});
