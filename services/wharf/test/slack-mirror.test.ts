import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { mirrorTables } from '../src/mirror-state.js';
import { sealToken } from '../src/slack-install.js';
import { authFixtures } from './auth-fixture.js';
import type { MirrorHelmRequestPayload, WharfHumanRequest, WharfMirrorCall } from '../../../packages/core/src/backend-model.js';
import { encodeFrame } from '../../../packages/core/src/wharf-socket.js';
import type { ServerSocketMessage } from '../../../packages/core/src/wharf-socket.js';

/**
 * A Slack request for a grounds a mirror boat runs locally goes to that
 * boat's own helm: wharf → the boat's socket → its local request queue. The
 * boat says whether its helm has it or keeps it queued, and sends the helm's
 * reply back to the thread. Only a boat with no socket open is offline.
 */

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `mirror-slack-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
async function slack(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}`;
  return SELF.fetch('https://state.test/slack/events', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signature, 'Content-Type': 'application/json' }, body });
}
const message = (event: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${++sequence}`, event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '1700000000.000100', text: 'Investigate the flaky checkout', ...event } });
const requestId = 'slack-D1-1700000000-000100';
const stored = () => runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => {
  const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM human_requests WHERE id=?', requestId).toArray()[0];
  return row ? (JSON.parse(row.data) as WharfHumanRequest) : undefined;
});
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type Posted = { method: string; body: { channel: string; ts?: string; thread_ts?: string; text: string; blocks: Array<{ text?: { text: string } }> } };
let posted: Posted[] = [];
/** What the request's receipt says now: its newest post or update. */
const receipt = () => posted.filter((p) => p.body.text.startsWith('Request:')).at(-1)!.body.blocks.map((b) => b.text?.text ?? '').join('\n');

type Boat = { id: string; token: string };
async function enrol(name: string, permissions = ['mirror', 'read']): Promise<Boat> {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  expect(result.status, JSON.stringify(result.value)).toBe(201);
  return result.value as Boat;
}
type BoatSocket = { socket: WebSocket; received: ServerSocketMessage[] };
async function boatSocket(boat: Boat, grounds: string[]): Promise<BoatSocket> {
  const r = await SELF.fetch('https://state.test/v1/accounts/a/wake', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${boat.token}`, 'Sec-WebSocket-Protocol': 'lobstah.2' } });
  expect(r.status).toBe(101);
  const socket = r.webSocket!; socket.accept();
  const received: ServerSocketMessage[] = [];
  socket.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data !== 'pong') received.push(JSON.parse(e.data)); });
  socket.send(JSON.stringify({ t: 'grounds', grounds }));
  // The grounds are kept once the account has read the message.
  await until(async () => (await env.ACCOUNTS.getByName('a').slackGrounds()).some((g) => grounds.includes(g)));
  return { socket, received };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('condition never held');
}
async function helmCall(b: BoatSocket, n = 1): Promise<WharfMirrorCall> {
  await until(() => b.received.filter((m) => m.t === 'call').length >= n);
  return (b.received.filter((m) => m.t === 'call')[n - 1] as Extract<ServerSocketMessage, { t: 'call' }>).call;
}
/** The boat's answer to a call, in a frame on its socket, as the daemon sends it. */
const answer = (b: BoatSocket, id: string, status: number, body: unknown) =>
  b.socket.send(encodeFrame({ t: 'answer', id, status, contentType: 'application/json' }, encode(JSON.stringify(body))));
const update = (boat: Boat, body: unknown) => call(`mirror/requests/${requestId}`, body, boat.token);

beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (instance: Account, state) => {
    for (const socket of state.getWebSockets()) socket.close();
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables, ...mirrorTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
    (instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
  });
  posted = [];
  let n = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://slack.com/api/')) return real(input, init);
    posted.push({ method: url.slice('https://slack.com/api/'.length), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, ts: `1800000000.${String(++n).padStart(6, '0')}` });
  });
  const linkedAt = '2026-10-30T00:00:00.000Z';
  await env.AUTH_DB.prepare('DELETE FROM slackLink').run();
  await env.AUTH_DB.prepare('DELETE FROM slackInstallation').run();
  await env.AUTH_DB.prepare('INSERT INTO slackInstallation VALUES (?,?,?,?,?,?)').bind('T1', 'B1', await sealToken(env, 'xoxb-test'), 'chat:write,im:write,im:history', 'a', linkedAt).run();
  await env.AUTH_DB.prepare('INSERT INTO slackLink VALUES (?,?,?,?,?,NULL)').bind('T1', 'U1', 'a', 'D1', linkedAt).run();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', grounds: ['away'], linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });

it('offers the grounds each mirror boat runs locally in the Slack picker, until the boat is revoked', async () => {
  expect(await env.ACCOUNTS.getByName('a').slackGrounds()).toEqual([]);
  const north = await enrol('north');
  await boatSocket(north, ['away', 'home']);
  expect(await env.ACCOUNTS.getByName('a').slackGrounds()).toEqual(['away', 'home']);
  expect((await call(`boats/${north.id}/revoke`, {})).status).toBe(200);
  expect(await env.ACCOUNTS.getByName('a').slackGrounds()).toEqual([]);
});

it('delivers a DM to the boat’s helm request queue, says it is queued while no helm holds the grounds, and updates when a helm signs on', async () => {
  const north = await enrol('north'), b = await boatSocket(north, ['away']);
  expect((await slack(message())).status).toBe(200);
  const relayed = await helmCall(b);
  expect(relayed.write).toEqual({ kind: 'helm-request', payload: expect.objectContaining({ request: requestId, grounds: 'away', text: 'Investigate the flaky checkout', by: 'a' }) });
  expect(await stored()).toMatchObject({ state: 'queued', mirror: { boat: north.id, name: 'north', state: 'sent' } });
  // The wharf's own helm never sees a mirror grounds' request.
  expect(await (await call('requests')).json()).toEqual([]);

  answer(b, relayed.id, 201, { ok: true, id: 'local-1', state: 'queued' });
  await until(async () => (await stored())?.mirror?.state === 'queued');
  await deliver();
  expect(receipt()).toContain('Queued — the helm will pick this up when it’s back');

  // A helm signs on at the boat: the daemon says the helm has it now.
  expect((await update(north, { state: 'delivered' })).status).toBe(200);
  await deliver();
  expect(await stored()).toMatchObject({ state: 'received', mirror: { state: 'delivered' } });
  expect(receipt()).toContain('Received · the helm has it');
  // A late queued answer never sends it back to waiting.
  expect((await update(north, { state: 'queued' })).status).toBe(200);
  expect((await stored())?.mirror?.state).toBe('delivered');
});

it('says at once when the boat’s helm already has it, sends the helm’s reply to the thread, and relays what the person adds', async () => {
  const north = await enrol('north'), b = await boatSocket(north, ['away']);
  await slack(message());
  const first = await helmCall(b);
  answer(b, first.id, 201, { ok: true, id: 'local-1', state: 'delivered' });
  await until(async () => (await stored())?.mirror?.state === 'delivered');

  expect((await update(north, { reply: 'Which branch?' })).status).toBe(200);
  await deliver();
  expect(receipt()).toContain('The helm replied: Which branch?');

  await slack(message({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'main' }));
  const followUp = await helmCall(b, 2);
  expect((followUp.write!.payload as MirrorHelmRequestPayload).followUp).toMatchObject({ text: 'main', source: '1700000000.000200' });
});

it('only the boat the request went to may update it', async () => {
  const north = await enrol('north'), south = await enrol('south'), b = await boatSocket(north, ['away']);
  await slack(message());
  await helmCall(b);
  expect((await update(south, { state: 'delivered' })).status).toBe(403);
  expect((await call(`requests/${requestId}/respond`, { text: 'from the wharf helm' })).status).toBe(409);
  expect((await update(north, { state: 'nonsense' })).status).toBe(400);
});

it('a boat that refuses the request ends it, and the receipt says so', async () => {
  const north = await enrol('north'), b = await boatSocket(north, ['away']);
  await slack(message());
  const relayed = await helmCall(b);
  answer(b, relayed.id, 400, { ok: false, reason: 'Unknown grounds.' });
  await until(async () => (await stored())?.mirror?.state === 'refused');
  await deliver();
  expect(receipt()).toContain('north couldn’t take this request. Send it again, or check the glass.');
});

it('replies offline only when the boat has no socket open, and relays nothing', async () => {
  const north = await enrol('north'), b = await boatSocket(north, ['away']);
  b.socket.close();
  await until(() => runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.getWebSockets(`boat:${north.id}`).length === 0));
  expect((await slack(message())).status).toBe(200);
  expect(await stored()).toMatchObject({ mirror: { state: 'offline' }, outcome: 'boat offline' });
  await deliver();
  expect(receipt()).toContain('north is offline. Send this again when it’s back.');
  const calls = await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec('SELECT id FROM mirror_calls').toArray());
  expect(calls).toEqual([]);
});

it('a person’s relayed call from the hosted glass may not make a helm request', async () => {
  const north = await enrol('north');
  await boatSocket(north, ['away']);
  const r = await call('mirror/calls', { id: 'call-person', boat: north.id, write: { kind: 'helm-request', payload: { request: 'x', grounds: 'away', text: 'x', by: 'a', at: '' } } });
  expect(r.status).toBe(403);
});
