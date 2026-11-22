import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { sealToken } from '../src/slack-install.js';
import type { SlackKind } from '../src/slack-outbox.js';
import { authFixtures } from './auth-fixture.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `kinds-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
const setKinds = (kinds: SlackKind[]) => env.ACCOUNTS.getByName('a').slackKinds('a', kinds);
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
/** A DM event as Slack signs it. */
async function dm(event: Record<string, unknown> = {}) {
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${++sequence}`, event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '1700000000.000100', text: 'Investigate the flaky checkout', ...event } });
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}`;
  expect((await SELF.fetch('https://state.test/slack/events', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signature, 'Content-Type': 'application/json' }, body })).status).toBe(200);
}
type Posted = { method: string; body: { channel: string; ts?: string; thread_ts?: string; text?: string } };
let posted: Posted[] = [];
/** What Slack answers a post or edit with. */
let answer: () => Response;
/** The messages of one card family, by the fallback text Slack shows: `Decision: …`, `Job: …`, `Request: …`. */
const of = (label: string) => posted.filter((p) => p.body.text?.startsWith(`${label}:`));
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
    // Request counts live in the instance's memory, not in meta.
    (_instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
  });
  posted = [];
  let n = 0;
  answer = () => Response.json({ ok: true, ts: `1800000000.${String(++n).padStart(6, '0')}` });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://slack.com/api/')) return real(input, init);
    posted.push({ method: url.slice('https://slack.com/api/'.length), body: JSON.parse(String(init?.body)) });
    return answer();
  });
  const linkedAt = '2026-10-30T00:00:00.000Z';
  await env.AUTH_DB.prepare('INSERT OR REPLACE INTO slackInstallation VALUES (?,?,?,?,?,?)').bind('T1', 'B1', await sealToken(env, 'xoxb-test'), 'chat:write,im:write,im:history', 'a', linkedAt).run();
  await env.AUTH_DB.prepare('INSERT OR REPLACE INTO slackLink VALUES (?,?,?,?,?,NULL)').bind('T1', 'U1', 'a', 'D1', linkedAt).run();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });
async function helm() {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: 'helm-boat', permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  const b = result.value as { token: string };
  expect((await call('helm/take', { session: 'seat' }, b.token, 'seat')).status).toBe(200);
  return b;
}
async function decision(b: { token: string }, id: string, title: string) {
  expect((await call('documents', { id, kind: 'decision', grounds: 'away', title, options: ['Keep the cache', 'Drop the cache'] }, b.token, 'seat')).status).toBe(200);
  expect((await call(`documents/${id}/publish`, {}, b.token, 'seat')).status).toBe(200);
}
const job = (b: { token: string }, id: string, brief: string) => call('dispatches', { id, grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief }, b.token, 'seat');

it('sk-off: with decisions and notices off, the outbox posts none of their cards, new, waiting or changed, and still posts jobs', async () => {
  const b = await helm();
  await decision(b, 'posted', 'Keep the build cache?');
  await deliver();
  expect(of('Decision')).toHaveLength(1);
  // Slack holds the next post back, so it still waits to go out when the group goes off.
  const ok = answer;
  answer = () => new Response('', { status: 429, headers: { 'Retry-After': '30' } });
  await decision(b, 'waiting', 'Pin Node 22 in CI?');
  await deliver();
  expect(await sql('SELECT count(*) AS n FROM slack_deliveries WHERE want>sent')).toEqual([{ n: 1 }]);
  answer = ok;
  expect(await setKinds(['permissions', 'prs', 'jobs'])).toEqual(['permissions', 'prs', 'jobs']);
  expect(await sql('SELECT count(*) AS n FROM slack_deliveries WHERE want>sent')).toEqual([{ n: 0 }]);
  const from = posted.length;
  await decision(b, 'new', 'Drop Safari 16?');
  expect((await call('documents/posted/ack', {})).status).toBe(200);
  expect((await job(b, 'job', 'Fix the flaky checkout test')).status).toBe(200);
  await deliver();
  // Only the job is sent. The decision already in Slack stays as it was, not edited.
  expect(posted.slice(from).map((p) => `${p.method} ${p.body.text?.split(' · ')[0]}`)).toEqual(['chat.postMessage Job: Fix the flaky checkout test']);
  expect(await sql('SELECT count(*) AS n FROM slack_deliveries WHERE want>sent')).toEqual([{ n: 0 }]);
  await deliver();
  expect(posted).toHaveLength(from + 1);
});

it('sk-on: turning decisions back on posts its standing cards, editing the message already in Slack, and none that ended', async () => {
  const b = await helm();
  await decision(b, 'posted', 'Keep the build cache?');
  await deliver();
  const card = (await (await call('cards')).json<Array<{ id: string; title: string }>>()).find((c) => c.title === 'Keep the build cache?')!;
  const [{ ts }] = await sql('SELECT ts FROM slack_deliveries WHERE card=?', Number(card.id.slice(1))) as Array<{ ts: string }>;
  await setKinds(['permissions', 'prs', 'jobs', 'notices']);
  await decision(b, 'waiting', 'Pin Node 22 in CI?');
  await decision(b, 'ended', 'Drop Safari 16?');
  expect((await call('documents/ended/answer', { option: 'Keep the cache' })).status).toBe(200);
  expect((await call('documents/posted/ack', {})).status).toBe(200);
  await deliver();
  expect(of('Decision')).toHaveLength(1);
  expect(await setKinds(['decisions', 'permissions', 'prs', 'jobs', 'notices'])).toEqual(['decisions', 'permissions', 'prs', 'jobs', 'notices']);
  await deliver();
  const decisions = of('Decision').slice(1);
  expect(decisions.map((p) => [p.method, p.body.text?.split(' · ')[0]])).toEqual(expect.arrayContaining([
    ['chat.update', 'Decision: Keep the build cache?'],
    ['chat.postMessage', 'Decision: Pin Node 22 in CI?'],
  ]));
  expect(decisions).toHaveLength(2);
  expect(decisions.find((p) => p.method === 'chat.update')!.body.ts).toBe(ts);
  expect(JSON.stringify(decisions)).not.toContain('Drop Safari 16?');
});

it('sk-requests: with every group off, a DM still gets its receipt, and its thread still gets Updated and Dispatch started', async () => {
  expect(await setKinds([])).toEqual([]);
  await dm();
  const b = await helm();
  await decision(b, 'pick', 'Keep the build cache?');
  expect((await job(b, 'other', 'Bump the lockfile')).status).toBe(200);
  await deliver();
  const receipts = of('Request').filter((p) => p.method === 'chat.postMessage');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ body: { channel: 'D1', thread_ts: '1700000000.000100' } });
  const reposts = () => posted.filter((p) => p.method === 'chat.postMessage' && p.body.thread_ts === '1700000000.000100' && !p.body.text?.startsWith('Request:')).map((p) => p.body.text?.split(':')[0]);
  await dm({ ts: '1700000000.000200', thread_ts: '1700000000.000100', text: 'It fails on Safari only' });
  await deliver();
  expect(reposts()).toEqual(['Updated']);
  const [request] = await (await call('requests')).json<Array<{ id: string }>>();
  expect((await call('dispatches', { id: 'job', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the flaky checkout on Safari', request: request!.id }, b.token, 'seat')).status).toBe(200);
  await deliver();
  expect(reposts()).toEqual(['Updated', 'Dispatch started']);
  // The receipt is still edited as the request moves on; no card of any group is sent.
  expect(of('Request').filter((p) => p.method === 'chat.update').length).toBeGreaterThan(0);
  expect(posted.filter((p) => p.method !== 'reactions.add' && p.body.thread_ts !== '1700000000.000100' && !p.body.text?.startsWith('Request:'))).toEqual([]);
});
