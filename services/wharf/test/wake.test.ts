import { env, SELF, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { authFixtures } from './auth-fixture.js';

let sequence = 0;
const api = (path: string, body?: unknown, token = 'test-helm-a', account = 'wake') => SELF.fetch(`https://state.test/v1/accounts/${account}/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `wake-${++sequence}`, 'X-Lobstah-Helm': 'helm' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
// Fresh named account per test; person authority is only a private fixture.
const stub = () => env.ACCOUNTS.getByName('wake');
const command = async (path: string, body?: unknown) => JSON.parse(await stub().handle(JSON.stringify({ account: 'wake', helm: true, personId: 'a', token: 'test-helm-a',
  method: body === undefined ? 'GET' : 'POST', path, body: body ?? {}, key: `wake-${++sequence}`, session: 'helm' })));
async function boat(permissions = ['work', 'helm']) {
  const result = await command('boats', { name: `boat-${sequence}`, permissions });
  expect(result.status).toBe(201); return result.value as { id: string; token: string };
}
const connect = (token: string, account = 'wake', headers: Record<string, string> = {}) => SELF.fetch(`https://state.test/v1/accounts/${account}/wake`, {
  headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}`, 'Sec-WebSocket-Protocol': 'lobstah.2', ...headers },
});
function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no wake hint')), 3000);
    socket.addEventListener('message', (e) => { clearTimeout(timeout); resolve(String(e.data)); }, { once: true });
  });
}
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(stub(), (_instance: Account, state) => {
    for (const socket of state.getWebSockets()) socket.close();
    for (const table of ['boats', 'boat_permissions', 'workers', 'configured_workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'claims']) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key!='generation'");
    // Request counts live in the instance's memory, not in meta.
    (_instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
  });
});
it('hibernates an idle connected account, restores its socket, and catches up after a drop from the durable cursor', async () => {
  const b = await boat(); const r = await connect(b.token); expect(r.status).toBe(101);
  const socket = r.webSocket!; socket.accept();
  const before = await runInDurableObject(stub(), (instance: Account, state) => {
    // A transient marker proves the actual instance was destroyed, not simulated.
    Object.assign(instance, { evictionMarker: 'old instance' });
    expect(state.getWebSockets()).toHaveLength(1);
    return state.storage.getAlarm();
  });
  expect(before).toBeNull();
  await evictDurableObject(stub(), { webSockets: 'hibernate' });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  await runInDurableObject(stub(), (instance: Account, state) => {
    expect(Reflect.get(instance, 'evictionMarker')).toBeUndefined();
    expect(state.getWebSockets()).toHaveLength(1);
    expect(state.getWebSockets()[0].deserializeAttachment().actor.id).toBe(b.id);
  });
  const pushed = message(socket);
  expect((await command('helm/take', { session: 'helm' })).status).toBe(200);
  expect(JSON.parse(await pushed)).toMatchObject({ t: 'event', events: [{ kind: 'helm-taken' }] });
  const read = await api('events', undefined, b.token); expect(read.status).toBe(200);
  const cursor = (await read.json<{ cursor: string }>()).cursor;
  expect(cursor).not.toBe(''); socket.close();
  expect((await command('dispatches', { id: 'missed', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'not socket content' })).status).toBe(200);
  const caught = await (await api(`events?after=${encodeURIComponent(cursor)}`, undefined, b.token)).json<{ events: { kind: string }[] }>();
  expect(caught.events.some((e) => e.kind === 'queued')).toBe(true);
  expect(await runInDurableObject(stub(), (_instance: Account, state) => state.storage.getAlarm())).toBeNull();
});
it('rejects wrong-account, unreadable and dispatch tokens; never trusts a supplied internal command', async () => {
  // A work-only boat listens for work to claim; a boat with neither read nor work has no socket.
  const b = await boat(['work']);
  const listening = await connect(b.token); expect(listening.status).toBe(101); listening.webSocket!.accept(); listening.webSocket!.close();
  expect((await connect(b.token, 'b')).status).toBe(403);
  // A supplied internal command is ignored: the socket is the boat's, never a helm's or a person's.
  const forged = await connect(b.token, 'wake', { 'X-Wharf-Command': JSON.stringify({ helm: true }) });
  expect(forged.status).toBe(101); forged.webSocket!.accept();
  const tags = await runInDurableObject(stub(), (_instance: Account, state) => state.getWebSockets().map((socket) => state.getTags(socket)));
  expect(tags.flat().filter((t) => !t.startsWith('boat'))).toEqual([]);
  forged.webSocket!.close();
  await command('helm/take', { session: 'helm' });
  await command('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' });
  await api('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token);
  const claim = await (await api('claims', { worker: 'worker' }, b.token)).json<{ token: string }>();
  expect((await connect(claim.token)).status).toBe(403);
  expect((await connect(b.token, 'wake', { Origin: 'https://evil.test' })).status).toBe(403);
  expect((await connect(b.token, 'wake', { Cookie: 'session=anything' })).status).toBe(401);
});
it('closes revoked sockets, and holds more than the old 32 connections', async () => {
  const b = await boat(); const sockets: WebSocket[] = [];
  for (let n = 0; n < 33; n++) { const r = await connect(b.token); expect(r.status).toBe(101); r.webSocket!.accept(); sockets.push(r.webSocket!); }
  const closed = new Promise((resolve) => sockets[0].addEventListener('close', resolve, { once: true }));
  await command(`boats/${b.id}/revoke`, {}); await closed;
  expect(sockets[0].readyState).not.toBe(WebSocket.OPEN);
  expect((await connect(b.token)).status).toBe(401);
  sockets.forEach((s) => s.close());
});
it('a message that is not a protocol command changes nothing and is answered with an error', async () => {
  const b = await boat(); const r = await connect(b.token); expect(r.status).toBe(101);
  const socket = r.webSocket!; socket.accept();
  const answer = message(socket);
  socket.send(JSON.stringify({ path: 'helm/take', body: { session: 'intruder' } }));
  expect(JSON.parse(await answer)).toMatchObject({ t: 'error', reason: 'unknown message type' });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(await runInDurableObject(stub(), (_instance: Account, state) => state.storage.sql.exec("SELECT * FROM meta WHERE key='helm'").toArray())).toEqual([]);
  socket.close();
});
