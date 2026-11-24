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
 * A person has one helm, and every Slack DM goes to it. A Mac's own helm
 * takes the wharf's seat over its mirror socket; a DM then goes wharf → the
 * boat's socket → a helm thread there. The boat says whether its helm has it
 * or it waits, and what changed, so the Slack thread gets a link. With no
 * helm holding the seat, a DM waits up to 7 days for the next one.
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
type Posted = { method: string; body: { channel: string; ts?: string; thread_ts?: string; text?: string; blocks?: Array<{ text?: { text: string }; elements?: Array<{ action_id: string; url?: string }> }> } };
let posted: Posted[] = [];
const receipts = () => posted.filter((p) => p.body.text?.startsWith('Request:'));
/** What the request's receipt says now: its newest post or update. */
const receipt = () => receipts().at(-1)!.body.blocks!.map((b) => b.text?.text ?? '').join('\n');
/** The new messages the request's thread got after its receipt: what each says, and the glass page it opens. */
const reposts = () => posted.filter((p) => p.method === 'chat.postMessage' && p.body.thread_ts && !p.body.text?.startsWith('Request:')).map((p) => ({
  thread: p.body.thread_ts, said: p.body.blocks!.map((b) => b.text?.text ?? '').join(''), opens: p.body.blocks!.flatMap((b) => b.elements ?? []).find((e) => e.action_id === 'open-glass')?.url,
}));

type Boat = { id: string; token: string };
async function enrol(name: string, permissions = ['mirror', 'read']): Promise<Boat> {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  expect(result.status, JSON.stringify(result.value)).toBe(201);
  return result.value as Boat;
}
type BoatSocket = { socket: WebSocket; received: ServerSocketMessage[] };
/** A Mac's helm session ids, as Claude Code names them. */
const MAC_SESSION = '3f2a1b9c-7d4e-4f10-9a2b-5c6d7e8f9a01', OTHER_SESSION = '8b7c6d5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
/** A mirror boat's socket; with `grounds`, its Mac's helm takes the seat on it, as `lobstah man helm` there does. */
async function boatSocket(boat: Boat, grounds?: string, session = MAC_SESSION): Promise<BoatSocket> {
  const r = await SELF.fetch('https://state.test/v1/accounts/a/wake', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${boat.token}`, 'Sec-WebSocket-Protocol': 'lobstah.2' } });
  expect(r.status).toBe(101);
  const socket = r.webSocket!; socket.accept();
  const received: ServerSocketMessage[] = [];
  socket.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data !== 'pong') received.push(JSON.parse(e.data)); });
  const b = { socket, received };
  if (grounds) expect((await takeSeat(b, session, grounds)).status).toBe(200);
  return b;
}
/** The Mac's helm takes the seat on its mirror socket, and the wharf's answer. */
async function takeSeat(b: BoatSocket, session: string, grounds: string, take = false): Promise<{ status: number; value: unknown }> {
  const id = `take-${++sequence}`;
  b.socket.send(JSON.stringify({ t: 'command', id, method: 'POST', path: 'helm/take', body: { session, grounds, mirror: true, ...(take ? { take } : {}) } }));
  await until(() => b.received.some((m) => m.t === 'result' && m.id === id));
  return b.received.find((m) => m.t === 'result' && m.id === id) as Extract<ServerSocketMessage, { t: 'result' }>;
}
/** The helm seat as the account holds it. */
const seat = () => runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) =>
  JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='helm'").toArray()[0]?.value ?? 'null'));
/** A helm in the cloud: a boat with helm, signing on as `lobstah man helm` on a wharf grounds does. */
async function cloudHelm(take = false, session = OTHER_SESSION, grounds = 'away') {
  const b = await enrol('cloud-helm', ['work', 'helm']);
  return { boat: b, taken: await call('helm/take', { session, grounds, ...(take ? { take } : {}) }, b.token, session) };
}
const calls = (b: BoatSocket) => b.received.filter((m) => m.t === 'call');
/** What the app posted in the DM's own thread. */
const threadPosts = () => posted.filter((p) => p.method === 'chat.postMessage' && p.body.thread_ts === '1700000000.000100');
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
const THREAD = '6f1c2a7e-3b4d-4c5e-8f9a-0b1c2d3e4f50';
/** Where the receipt's Open in glass button goes. */
const opens = () => receipts().at(-1)!.body.blocks!.flatMap((b) => b.elements ?? []).find((e) => e.action_id === 'open-card')?.url;
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
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });

it('hr-mac-seat: a Mac’s helm takes the seat over its mirror socket, and the seat names its session and boat at once', async () => {
  const mac = await enrol('chriss-macbook-pro');
  const started = Date.now();
  const b = await boatSocket(mac, 'home');
  expect(await seat()).toMatchObject({ session: MAC_SESSION, actor: `boat:${mac.id}`, boat: 'chriss-macbook-pro', grounds: 'home', mirror: true });
  expect((await seat()).until).toBeGreaterThan(Date.now());
  expect(Date.now() - started).toBeLessThan(30_000);
  // A Mac's helm steers its own boat: the wharf's helm routes stay closed to it.
  expect(await (await call('glass')).json()).toMatchObject({ helmLive: false });
  // Taking it again renews it, and only a new holder is news.
  const taken = () => runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec("SELECT seq FROM events WHERE kind='helm-taken'").toArray().length);
  expect(await taken()).toBe(1);
  expect((await takeSeat(b, MAC_SESSION, 'home')).status).toBe(200);
  expect(await taken()).toBe(1);
  // Only a mirror boat takes the seat for its Mac, and only with its grounds named.
  const reader = await enrol('reader', ['read']);
  expect((await call('helm/take', { session: OTHER_SESSION, grounds: 'home', mirror: true }, reader.token, OTHER_SESSION)).status).toBe(403);
  expect((await call('helm/take', { session: OTHER_SESSION, grounds: 'home', mirror: true }, person, OTHER_SESSION)).status).toBe(403);
  expect((await takeSeat(b, MAC_SESSION, '')).status).toBe(400);
});

it('hr-seat-dm: while a Mac’s helm holds the seat, a DM goes to it at once with no question in Slack', async () => {
  const mac = await enrol('chriss-macbook-pro'), b = await boatSocket(mac, 'home');
  expect((await slack(message())).status).toBe(200);
  const relayed = await helmCall(b);
  expect(relayed.write).toEqual({ kind: 'helm-request', payload: expect.objectContaining({ request: requestId, grounds: 'home', text: 'Investigate the flaky checkout', by: 'a' }) });
  await deliver();
  expect(receipt()).toContain('Sent to home · chriss-macbook-pro');
  // Its context line names the Mac it went to.
  expect(JSON.stringify(receipts().at(-1)!.body.blocks)).toContain('Request · home · chriss-macbook-pro');
  // One message in the thread: the receipt. Nothing asks the person anything.
  expect(threadPosts()).toEqual([receipts()[0]]);
  expect(JSON.stringify(posted)).not.toContain('Which grounds');
  // The wharf's own helm never sees it.
  expect(await (await call('requests')).json()).toEqual([]);
});

it('hr-seat-dm: while the wharf’s helm holds the seat, a DM wakes it on its grounds with no question in Slack', async () => {
  const north = await enrol('north'), b = await boatSocket(north);
  expect((await cloudHelm()).taken.status).toBe(200);
  expect((await slack(message())).status).toBe(200);
  expect(await (await call('requests')).json()).toMatchObject([{ id: requestId, grounds: 'away', state: 'queued', waitingForHelm: false }]);
  expect(await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec("SELECT kind FROM events WHERE kind='human-request'").toArray())).toHaveLength(1);
  await deliver();
  expect(receipt()).toContain('Received · queued for the helm');
  expect(threadPosts()).toEqual([receipts()[0]]);
  expect(JSON.stringify(posted)).not.toContain('Which grounds');
  expect(calls(b)).toEqual([]);
});

it('hr-second: a second helm without take is refused, naming the one that holds the seat', async () => {
  const mac = await enrol('chriss-macbook-pro'); await boatSocket(mac, 'home');
  const held = 'The helm is held by session 3f2a1b9c on chriss-macbook-pro. Sign on with --take to take it over, or leave it.';
  // From the cloud.
  const cloud = await cloudHelm(false, OTHER_SESSION, 'home');
  expect(cloud.taken.status).toBe(409);
  expect(await cloud.taken.json()).toMatchObject({ error: held, holder: { session: MAC_SESSION, boat: 'chriss-macbook-pro' } });
  // From another Mac, or another session on the same Mac.
  const other = await boatSocket(await enrol('studio-mac'));
  expect(await takeSeat(other, OTHER_SESSION, 'home')).toMatchObject({ status: 409, value: { error: held } });
  expect(await takeSeat(await boatSocket(mac), OTHER_SESSION, 'home')).toMatchObject({ status: 409, value: { error: held } });
  expect(await seat()).toMatchObject({ session: MAC_SESSION, boat: 'chriss-macbook-pro' });
  // A cloud helm holding the seat is named too.
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec("DELETE FROM meta WHERE key='helm' OR key LIKE 'helm:%'"));
  expect((await call('helm/take', { session: OTHER_SESSION, grounds: 'home' }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect(await takeSeat(other, MAC_SESSION, 'home')).toMatchObject({ status: 409, value: { error: 'The helm is held by session 8b7c6d5e on cloud-helm. Sign on with --take to take it over, or leave it.' } });
});

it('hr-take: a second helm with take displaces the first, the first learns it, and the next DM reaches the second', async () => {
  const mac = await enrol('chriss-macbook-pro'), first = await boatSocket(mac, 'home');
  const cloud = await cloudHelm(true, OTHER_SESSION, 'home');
  expect(cloud.taken.status).toBe(200);
  expect(await seat()).toMatchObject({ session: OTHER_SESSION, boat: 'cloud-helm' });
  // The Mac's next renewal is refused, naming the new holder: its helm stands down.
  expect(await takeSeat(first, MAC_SESSION, 'home')).toMatchObject({ status: 409, value: { holder: { session: OTHER_SESSION } } });
  expect((await slack(message())).status).toBe(200);
  expect(await (await call('requests')).json()).toMatchObject([{ id: requestId, grounds: 'home', waitingForHelm: false }]);
  expect(calls(first)).toEqual([]);

  // A Mac's helm takes it back with take: the next DM reaches that Mac.
  const studio = await boatSocket(await enrol('studio-mac'));
  expect((await takeSeat(studio, MAC_SESSION, 'home', true)).status).toBe(200);
  expect((await call('helm/renew', {}, cloud.boat.token, OTHER_SESSION)).status).toBe(409);
  // The request the cloud helm never took goes with the seat; the next DM follows it.
  expect((await helmCall(studio)).write).toMatchObject({ payload: { request: requestId, grounds: 'home' } });
  expect((await slack(message({ ts: '1700000000.000900', text: 'Ship the release notes' }))).status).toBe(200);
  expect((await helmCall(studio, 2)).write).toMatchObject({ payload: { request: 'slack-D1-1700000000-000900', grounds: 'home' } });
  expect(calls(first)).toEqual([]);
});

it('hr-queued: with no helm the receipt says Queued, and the request reaches the next helm to sign on within 7 days', async () => {
  expect((await slack(message())).status).toBe(200);
  const queued = (await stored())!;
  expect(queued).toMatchObject({ state: 'queued' });
  expect(queued.grounds).toBeUndefined();
  expect(Date.parse(queued.expiresAt) - Date.parse(queued.at)).toBe(7 * 86_400_000);
  await deliver();
  expect(receipt()).toContain('Queued — the helm will pick this up when it’s back');
  await slack(message({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'It fails on Safari only' }));

  // Six days on, a Mac's helm signs on: the request, with what the person added, goes to it.
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => {
    const r = { ...queued, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    state.storage.sql.exec("UPDATE human_requests SET data=json_set(data,'$.expiresAt',?) WHERE id=?", r.expiresAt, requestId);
  });
  const mac = await enrol('chriss-macbook-pro'), b = await boatSocket(mac, 'home');
  expect((await helmCall(b)).write).toEqual({ kind: 'helm-request', payload: expect.objectContaining({ request: requestId, grounds: 'home', text: 'Investigate the flaky checkout\n\nIt fails on Safari only' }) });
  expect(await stored()).toMatchObject({ grounds: 'home', mirror: { boat: mac.id, name: 'chriss-macbook-pro', state: 'sent' } });
  await deliver();
  expect(receipt()).toContain('Sent to home · chriss-macbook-pro');
  // It went once: taking the seat again sends nothing more.
  expect((await takeSeat(b, MAC_SESSION, 'home')).status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(b)).toHaveLength(1);
});

it('hr-queued: a queued request reaches a wharf helm that signs on next, and may run on the grounds it picks', async () => {
  expect((await slack(message())).status).toBe(200);
  const cloud = await cloudHelm();
  expect(cloud.taken.status).toBe(200);
  expect(await (await call('requests')).json()).toMatchObject([{ id: requestId, state: 'queued', waitingForHelm: false }]);
  await deliver();
  expect(receipt()).toContain('Received · queued for the helm');
  const job = { id: 'fix-checkout', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the flaky checkout on Safari', request: requestId };
  expect((await call('dispatches', job, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect(await stored()).toMatchObject({ state: 'fulfilled', dispatch: 'fix-checkout' });
});

it('hr-queued: a request older than 7 days reaches no helm', async () => {
  expect((await slack(message())).status).toBe(200);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) =>
    state.storage.sql.exec("UPDATE human_requests SET data=json_set(data,'$.expiresAt',?) WHERE id=?", new Date(Date.now() - 1000).toISOString(), requestId));
  const b = await boatSocket(await enrol('chriss-macbook-pro'), 'home');
  await new Promise((r) => setTimeout(r, 50));
  expect(calls(b)).toEqual([]);
  expect(await stored()).toMatchObject({ state: 'expired' });
});

it('relays a DM to the boat’s helm, says it is queued while no helm holds the grounds, and updates when a helm signs on', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  expect((await slack(message())).status).toBe(200);
  const relayed = await helmCall(b);
  expect(relayed.write).toEqual({ kind: 'helm-request', payload: expect.objectContaining({ request: requestId, grounds: 'away', text: 'Investigate the flaky checkout', by: 'a' }) });
  expect(await stored()).toMatchObject({ state: 'queued', mirror: { boat: north.id, name: 'north', state: 'sent' } });
  // The wharf's own helm never sees a mirror grounds' request.
  expect(await (await call('requests')).json()).toEqual([]);

  answer(b, relayed.id, 201, { ok: true, thread: THREAD, state: 'queued' });
  await until(async () => (await stored())?.mirror?.state === 'queued');
  await deliver();
  expect(receipt()).toContain('Queued — the helm will pick this up when it’s back');
  // The receipt opens the helm thread the request opened on its boat.
  expect(await stored()).toMatchObject({ mirror: { thread: THREAD } });
  expect(opens()).toBe(`${env.GLASS_ORIGIN}/#thread/${THREAD}`);

  // A helm signs on at the boat: the daemon says the helm has it now.
  expect((await update(north, { state: 'delivered' })).status).toBe(200);
  await deliver();
  expect(await stored()).toMatchObject({ state: 'received', mirror: { state: 'delivered' } });
  expect(receipt()).toContain('Sent to away · north');
  // Where the request stands edits the one receipt; it is no update to the thread.
  expect(receipts().filter((p) => p.method === 'chat.postMessage')).toHaveLength(1);
  expect(reposts()).toEqual([]);
  // A late queued answer never sends it back to waiting.
  expect((await update(north, { state: 'queued' })).status).toBe(200);
  expect((await stored())?.mirror?.state).toBe('delivered');
});

it('posts one receipt that says where the request went and opens its glass thread, and never the helm’s words', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  await slack(message());
  const first = await helmCall(b);
  answer(b, first.id, 201, { ok: true, thread: THREAD, state: 'delivered' });
  await until(async () => (await stored())?.mirror?.state === 'delivered');
  await deliver();
  // One message, edited as the request moves: never a second receipt.
  expect(receipts().filter((p) => p.method === 'chat.postMessage')).toEqual([expect.objectContaining({ body: expect.objectContaining({ channel: 'D1', thread_ts: '1700000000.000100' }) })]);
  expect(receipt()).toContain('Sent to away · north');
  expect(opens()).toBe(`${env.GLASS_ORIGIN}/#thread/${THREAD}`);

  // A boat from before updates still sends its helm's words: they count as an update, and are kept nowhere.
  expect((await update(north, { reply: 'Which branch?' })).status).toBe(200);
  await deliver();
  expect(receipts().filter((p) => p.method === 'chat.postMessage')).toHaveLength(1);
  expect(reposts()).toEqual([{ thread: '1700000000.000100', said: 'Updated', opens: `${env.GLASS_ORIGIN}/#thread/${THREAD}` }]);
  expect((await stored())?.response).toBeUndefined();
  expect(JSON.stringify(posted)).not.toContain('Which branch?');
});

it('posts one new message for each update of the glass thread, and one per dispatch with its glass link; an update heard twice posts once', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  await slack(message());
  const first = await helmCall(b);
  answer(b, first.id, 201, { ok: true, thread: THREAD, state: 'delivered' });
  await until(async () => (await stored())?.mirror?.state === 'delivered');
  await deliver();
  const thread = { thread: '1700000000.000100', opens: `${env.GLASS_ORIGIN}/#thread/${THREAD}` };

  expect((await update(north, { updated: 1, dispatches: [] })).status).toBe(200);
  await deliver();
  expect(reposts()).toEqual([{ ...thread, said: 'Updated' }]);
  // The same update again, as after a lost answer: nothing new.
  expect((await update(north, { updated: 1, dispatches: [] })).status).toBe(200);
  await deliver();
  expect(reposts()).toHaveLength(1);

  // The helm started a dispatch: that is the message, with the dispatch's link.
  expect((await update(north, { updated: 2, dispatches: ['fix-checkout'] })).status).toBe(200);
  expect((await update(north, { updated: 2, dispatches: ['fix-checkout'] })).status).toBe(200);
  await deliver();
  expect(reposts().slice(1)).toEqual([{ thread: '1700000000.000100', said: 'Dispatch started', opens: `${env.GLASS_ORIGIN}/#job/fix-checkout` }]);
  // A later update names the same dispatch: it is an update, not a new dispatch.
  expect((await update(north, { updated: 3, dispatches: ['fix-checkout'] })).status).toBe(200);
  await deliver();
  expect(reposts().slice(2)).toEqual([{ ...thread, said: 'Updated' }]);
  expect(receipts().filter((p) => p.method === 'chat.postMessage')).toHaveLength(1);
  expect((await update(north, { updated: -1 })).status).toBe(400);
  expect((await update(north, { updated: 4, dispatches: ['../x'] })).status).toBe(400);
});

it('relays what the person adds in the thread to the boat’s helm, and reposts the link once', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  await slack(message());
  const first = await helmCall(b);
  answer(b, first.id, 201, { ok: true, thread: THREAD, state: 'delivered' });
  await until(async () => (await stored())?.mirror?.state === 'delivered');
  await deliver();
  await slack(message({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'main' }));
  const followUp = await helmCall(b, 2);
  expect((followUp.write!.payload as MirrorHelmRequestPayload).followUp).toMatchObject({ text: 'main', source: '1700000000.000200' });
  await deliver();
  expect(reposts()).toEqual([{ thread: '1700000000.000100', said: 'Updated', opens: `${env.GLASS_ORIGIN}/#thread/${THREAD}` }]);
});

it('only the boat the request went to may update it', async () => {
  const north = await enrol('north'), south = await enrol('south'), b = await boatSocket(north, 'away');
  await slack(message());
  await helmCall(b);
  expect((await update(south, { state: 'delivered' })).status).toBe(403);
  expect((await call(`requests/${requestId}/respond`, { text: 'from the wharf helm' })).status).toBe(409);
  expect((await update(north, { state: 'nonsense' })).status).toBe(400);
});

it('a boat that refuses the request ends it, and the receipt says so', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  await slack(message());
  const relayed = await helmCall(b);
  answer(b, relayed.id, 400, { ok: false, reason: 'Unknown grounds.' });
  await until(async () => (await stored())?.mirror?.state === 'refused');
  await deliver();
  expect(receipt()).toContain('north couldn’t take this request. Send it again, or check the glass.');
});

it('while the seat holder’s socket is away a DM waits as Queued, and reaches that Mac when its socket is back', async () => {
  const north = await enrol('north'), b = await boatSocket(north, 'away');
  b.socket.close();
  await until(() => runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.getWebSockets(`boat:${north.id}`).length === 0));
  expect((await slack(message())).status).toBe(200);
  expect((await stored())!.mirror).toBeUndefined();
  expect(await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec('SELECT id FROM mirror_calls').toArray())).toEqual([]);
  await deliver();
  expect(receipt()).toContain('Queued — the helm will pick this up when it’s back');
  // The Mac's socket resumes while its helm still holds the seat.
  const back = await boatSocket(north);
  back.socket.send(JSON.stringify({ t: 'resume' }));
  expect((await helmCall(back)).write).toMatchObject({ payload: { request: requestId, grounds: 'away' } });
  await deliver();
  expect(receipt()).toContain('Sent to away · north');
});

it('a person’s relayed call from the hosted glass may not make a helm request', async () => {
  const north = await enrol('north');
  await boatSocket(north, 'away');
  const r = await call('mirror/calls', { id: 'call-person', boat: north.id, write: { kind: 'helm-request', payload: { request: 'x', grounds: 'away', text: 'x', by: 'a', at: '' } } });
  expect(r.status).toBe(403);
});

it('keeps leases independent for two boats on one account with a shared repo', async () => {
  const mac = await enrol('home-mac'), socket = await boatSocket(mac, 'home');
  const cloud = await cloudHelm(true, OTHER_SESSION, 'helm-test');
  expect(cloud.taken.status).toBe(200);
  expect((await takeSeat(socket, MAC_SESSION, 'home')).status).toBe(200);
  // The cloud grounds can enqueue the very same repo that home oversees.
  const sharedRepo = { repo: 'lobstah-pond', repoRemote: 'github.com/chrishsu/lobstah-pond', brief: 'Shared repo' };
  expect((await call('dispatches', { id: 'shared-b', grounds: 'helm-test', ...sharedRepo }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect((await call('helm/renew', { grounds: 'helm-test' }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect((await call('helm/release', { grounds: 'home' }, cloud.boat.token, OTHER_SESSION)).status).toBe(409);
  expect((await call('helm/release', { grounds: 'helm-test' }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect((await takeSeat(socket, MAC_SESSION, 'home')).status).toBe(200);
  const leases = await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) =>
    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key LIKE 'helm:%'").toArray().map((row) => JSON.parse(row.value)));
  expect(leases).toEqual(expect.arrayContaining([
    expect.objectContaining({ grounds: 'home', session: MAC_SESSION, mirror: true }),
    expect.objectContaining({ grounds: 'helm-test', session: OTHER_SESSION, until: 0 }),
  ]));
});

it('allows both grounds to dispatch a shared repo after a takeover on the other grounds', async () => {
  const home = await enrol('home-boat', ['work', 'helm']);
  const sharedRepo = { repo: 'lobstah-pond', repoRemote: 'github.com/chrishsu/lobstah-pond', brief: 'Shared repo' };
  expect((await call('helm/take', { session: MAC_SESSION, grounds: 'home' }, home.token, MAC_SESSION)).status).toBe(200);
  expect((await call('dispatches', { id: 'home-before', grounds: 'home', ...sharedRepo }, home.token, MAC_SESSION)).status).toBe(200);
  const cloud = await cloudHelm(true, OTHER_SESSION, 'helm-test');
  expect(cloud.taken.status).toBe(200);
  expect((await call('dispatches', { id: 'cloud-after', grounds: 'helm-test', ...sharedRepo }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect((await call('helm/renew', { grounds: 'home' }, home.token, MAC_SESSION)).status).toBe(200);
  expect((await call('dispatches', { id: 'home-after', grounds: 'home', ...sharedRepo }, home.token, MAC_SESSION)).status).toBe(200);
});

it('migrates an old account lease only into its recorded grounds', async () => {
  const home = await enrol('home-boat', ['work', 'helm']);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES ('helm',?)", JSON.stringify({ session: MAC_SESSION, actor: `boat:${home.id}`, grounds: 'home', until: Date.now() + 120_000, remindSecs: 900 }));
  });
  const cloud = await cloudHelm(false, OTHER_SESSION, 'helm-test');
  expect(cloud.taken.status).toBe(200);
  expect((await call('helm/renew', { grounds: 'home' }, home.token, MAC_SESSION)).status).toBe(200);
  expect((await call('helm/release', { grounds: 'helm-test' }, cloud.boat.token, OTHER_SESSION)).status).toBe(200);
  expect((await call('helm/renew', { grounds: 'home' }, home.token, MAC_SESSION)).status).toBe(200);
});
