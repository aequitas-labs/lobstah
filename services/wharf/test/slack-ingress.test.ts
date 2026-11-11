import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { sealToken } from '../src/slack-install.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfHumanRequest } from '../../../packages/core/src/backend-model.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `ingress-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
/** A request as Slack signs it: v0 HMAC of `v0:<ts>:<body>` under the signing secret. */
async function slack(path: string, body: string, opts: { ts?: number; secret?: string; headers?: Record<string, string> } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode(opts.secret ?? 'stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}`;
  return SELF.fetch(`https://state.test${path}`, { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signature, 'Content-Type': 'application/json', ...opts.headers }, body });
}
const message = (event: Record<string, unknown>, eventId = `Ev${++sequence}`, team = 'T1') =>
  JSON.stringify({ type: 'event_callback', team_id: team, event_id: eventId, event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '1700000000.000100', text: 'Investigate the flaky checkout', ...event } });
const requests = async () => (await call('requests')).json<WharfHumanRequest[]>();
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type Posted = { method: string; body: { channel: string; ts?: string; thread_ts?: string; text: string; blocks: Array<{ text?: { text: string } }> } };
let posted: Posted[] = [];
const receipts = () => posted.filter((p) => p.body.text.startsWith('Request:'));
const section = (p: Posted) => p.body.blocks.map((b) => b.text?.text ?? '').join('\n');
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
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
  await env.AUTH_DB.prepare('INSERT INTO slackInstallation VALUES (?,?,?,?,?,?)').bind('T1', 'B1', await sealToken(env, 'xoxb-test'), 'chat:write,im:write,im:history', 'a', linkedAt).run();
  await env.AUTH_DB.prepare('INSERT INTO slackLink VALUES (?,?,?,?,?,NULL)').bind('T1', 'U1', 'a', 'D1', linkedAt).run();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });
async function helm() {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: 'helm-boat', permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  const b = result.value as { token: string };
  expect((await call('helm/take', { session: 'seat' }, b.token, 'seat')).status).toBe(200);
  return b;
}

it('checks Slack’s signature over the exact bytes and its time before reading anything', async () => {
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-123' });
  const answered = await slack('/slack/events', challenge);
  expect(answered.status).toBe(200); expect(await answered.text()).toBe('c-123');
  expect((await slack('/slack/events', challenge, { secret: 'another-secret' })).status).toBe(401);
  expect((await slack('/slack/events', challenge, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
  expect((await SELF.fetch('https://state.test/slack/events', { method: 'POST', body: challenge })).status).toBe(401);
  // A body changed after signing is a different body.
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = await slack('/slack/events', challenge, { ts: Number(ts) });
  expect(signed.status).toBe(200);
  expect((await SELF.fetch('https://glass.test/slack/events', { method: 'POST', body: challenge })).status).toBe(404);
  expect((await slack('/slack/interactions', 'payload=%7B%7D')).status).toBe(200);
});

it('a DM asks for work once: recorded, then a canned receipt in its thread; a retry is the same request', async () => {
  expect((await slack('/slack/events', message({}, 'EvSame'))).status).toBe(200);
  expect((await slack('/slack/events', message({}, 'EvSame'), { headers: { 'X-Slack-Retry-Num': '1', 'X-Slack-Retry-Reason': 'http_timeout' } })).status).toBe(200);
  const [request] = await requests();
  expect(request).toMatchObject({ kind: 'work', state: 'queued', text: 'Investigate the flaky checkout', by: 'a', origin: { team: 'T1', user: 'U1', channel: 'D1', ts: '1700000000.000100' } });
  expect(await requests()).toHaveLength(1);
  await deliver();
  expect(receipts()).toHaveLength(1);
  expect(receipts()[0]).toMatchObject({ method: 'chat.postMessage', body: { channel: 'D1', thread_ts: '1700000000.000100' } });
  // Received is not running: no helm is live, so it says it waits.
  expect(section(receipts()[0]!)).toContain('Received · waiting for the helm');
});

it('only the linked person, in the DM the app opened, with their own words, asks for anything', async () => {
  for (const event of [{ user: 'U2' }, { channel: 'D2' }, { bot_id: 'B1' }, { user: 'B1' }, { subtype: 'message_changed' }, { channel_type: 'channel' }, { text: '   ' }]) {
    expect((await slack('/slack/events', message(event))).status).toBe(200);
  }
  expect((await slack('/slack/events', message({}, 'EvOther', 'T2'))).status).toBe(200);
  expect(await requests()).toEqual([]);
});

it('a reply in the request’s thread adds to it; a reply under any other message does nothing', async () => {
  await slack('/slack/events', message({}));
  await slack('/slack/events', message({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'It fails on Safari only' }));
  await slack('/slack/events', message({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'It fails on Safari only' }));
  await slack('/slack/events', message({ ts: '1700000000.000300', thread_ts: '1799999999.000001', text: 'about that card' }));
  const all = await requests();
  expect(all).toHaveLength(1);
  expect(all[0]!.followUps).toEqual([{ text: 'It fails on Safari only', at: expect.any(String), source: '1700000000.000200' }]);
  await deliver();
  expect(section(receipts().at(-1)!)).toContain('1 more in this thread');
});

it('the helm answers or dispatches it; the same receipt says so, and a dispatch fulfills it once', async () => {
  await slack('/slack/events', message({}));
  const [{ id }] = await requests();
  const b = await helm();
  await deliver();
  expect((await call(`requests/${id}/execute`, {}, b.token, 'seat')).status).toBe(409);
  expect((await call(`requests/${id}/respond`, { text: 'Which repo?' })).status).toBe(409);
  expect((await call(`requests/${id}/respond`, { text: 'Which repo?' }, b.token, 'seat')).status).toBe(200);
  await deliver();
  expect(receipts().at(-1)).toMatchObject({ method: 'chat.update' });
  expect(section(receipts().at(-1)!)).toContain('The helm replied: Which repo?');
  const job = { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the flaky checkout on Safari', request: id };
  expect((await call('dispatches', job, b.token, 'seat')).status).toBe(200);
  expect((await call('dispatches', { ...job, id: 'job-2' }, b.token, 'seat')).status).toBe(409);
  expect((await requests())[0]).toMatchObject({ state: 'fulfilled', dispatch: 'job', outcome: 'dispatched as job' });
  await deliver();
  expect(section(receipts().at(-1)!)).toContain('Dispatched as job');
  expect(receipts().filter((p) => p.method === 'chat.postMessage')).toHaveLength(1);
});
