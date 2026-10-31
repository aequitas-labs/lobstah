import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { sealToken } from '../src/slack-install.js';
import { authFixtures } from './auth-fixture.js';
import type { CardAnswerReceipt, GlassCard } from '../../../packages/core/src/backend-model.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person) => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': 'helm', 'Idempotency-Key': `boat-answers-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
async function press(value: string) {
  const body = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', trigger_id: 't', team: { id: 'T1' }, user: { id: 'U1' }, container: { channel_id: 'D1' }, actions: [{ value }] }))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return SELF.fetch('https://state.test/slack/interactions', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}` }, body });
}
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type Element = { text: { text: string }; value?: string };
type Posted = { method: string; body: { text: string; blocks: Array<{ type: string; elements?: Array<Element | { text: string }> }> } };
let posted: Posted[] = [];
const latest = () => posted.filter((p) => p.body.text?.startsWith('Permission:')).at(-1)!;
const buttons = () => Object.fromEntries(latest().body.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements as Element[]).map((e) => [e.text.text, e]));
const context = () => (latest().body.blocks.find((b) => b.type === 'context')!.elements![0] as { text: string }).text;
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
async function boat(name: string, permissions: string[]) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  return result.value as { token: string; id: string };
}
const permission = { family: 'permission', key: 'decision:grant1', stateHash: 'asked-1', sourceAt: '2026-10-30T12:00:00.000Z', title: 'Allow: wrangler deploy',
  summary: 'Run: wrangler deploy\ntrap early-pebble · codex', grounds: 'away', actions: [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }] };
async function published() {
  const fisher = await boat('fisher', ['work']);
  expect((await call('cards', { cards: [permission] }, fisher.token)).status).toBe(200);
  await deliver();
  return fisher;
}

it('Allow pressed in Slack becomes a receipt for the card’s boat; the message says it awaits that boat, then what the boat did', async () => {
  const fisher = await published();
  expect(Object.keys(buttons())).toEqual(['Allow once', 'Allow always', 'No', 'Open in glass']);
  await press(buttons()['Allow once']!.value!);
  const [receipt] = await (await call('cards/answers', undefined, fisher.token)).json<CardAnswerReceipt[]>();
  expect(receipt).toMatchObject({ family: 'permission', key: 'decision:grant1', stateHash: 'asked-1', revision: 1, action: { kind: 'allow-once' }, by: 'a', state: 'pending' });
  await deliver();
  // Recorded is not granted: the message says so, and offers nothing more.
  expect(context()).toContain('Allow once recorded · awaiting its boat');
  expect(Object.keys(buttons())).toEqual(['Open in glass']);
  expect((await call(`cards/answers/${receipt!.id}`, { state: 'applied', outcome: 'grant g1' }, fisher.token)).status).toBe(200);
  // The boat restates its glass without the answered card: it ends, still saying what was applied.
  expect((await call('cards', { cards: [] }, fisher.token)).status).toBe(200);
  await deliver();
  expect(context()).toMatch(/Resolved .* Allow once applied on its boat/);
  const card = (await (await call('cards')).json<GlassCard[]>()).find((c) => c.key === 'decision:grant1')!;
  expect(card).toMatchObject({ terminal: { state: 'resolved' }, relay: { state: 'applied', answer: 'Allow once', outcome: 'grant g1' } });
  expect(await (await call('cards/answers', undefined, fisher.token)).json()).toEqual([]);
});

it('the first answer to a state stands; another boat neither reads nor settles it', async () => {
  const fisher = await published();
  const { 'Allow always': always, No: no } = buttons();
  await press(always!.value!);
  await press(always!.value!);
  await press(no!.value!);
  const receipts = await (await call('cards/answers', undefined, fisher.token)).json<CardAnswerReceipt[]>();
  expect(receipts.map((r) => r.action.kind)).toEqual(['allow-always']);
  const other = await boat('other', ['work', 'read']);
  expect(await (await call('cards/answers', undefined, other.token)).json()).toEqual([]);
  expect((await call(`cards/answers/${receipts[0]!.id}`, { state: 'applied' }, other.token)).status).toBe(404);
  expect((await call('cards/answers')).status).toBe(403);
});

it('a refused or expired answer says why, and the card can be answered again', async () => {
  const fisher = await published();
  await press(buttons()['Allow once']!.value!);
  const [first] = await (await call('cards/answers', undefined, fisher.token)).json<CardAnswerReceipt[]>();
  expect((await call(`cards/answers/${first!.id}`, { state: 'refused', outcome: 'This boat takes Allow only in its own glass' }, fisher.token)).status).toBe(200);
  expect((await call(`cards/answers/${first!.id}`, { state: 'applied' }, fisher.token)).status).toBe(409);
  await deliver();
  expect(context()).toContain('Allow once refused: This boat takes Allow only in its own glass');
  expect(Object.keys(buttons())).toEqual(['Allow once', 'Allow always', 'No', 'Open in glass']);
  await press(buttons().No!.value!);
  // An answer no boat takes in fifteen minutes expires; it is never applied late.
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec("UPDATE card_answers SET data=json_set(data,'$.at','2000-01-01T00:00:00.000Z') WHERE json_extract(data,'$.state')='pending'"));
  expect(await (await call('cards/answers', undefined, fisher.token)).json()).toEqual([]);
  await deliver();
  expect(context()).toContain('No expired: its boat did not take it in time; answer again');
});
