import { env, SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { mirrorTables } from '../src/mirror-state.js';
import { LAPSED_CLOSE_MS, MIRRORED_CARD_MS } from '../src/cards.js';
import { sealToken } from '../src/slack-install.js';
import { authFixtures } from './auth-fixture.js';
import type { CardAnswerReceipt, GlassCard } from '../../../packages/core/src/backend-model.js';

/**
 * A mirror boat's local grounds ("home") on the wharf: the boat restates
 * its standing cards with its mirror credential, a person linked to home
 * gets each as a Slack DM, answers it there for the boat to apply, and a
 * card the boat stops restating for MIRRORED_CARD_MS lapses: it leaves
 * Slack and the hosted deck, and its rows go. A wharf grounds' cards keep
 * standing as before.
 */

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person) => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': 'helm', 'Idempotency-Key': `mirror-cards-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
async function press(value: string) {
  const body = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', trigger_id: 't', team: { id: 'T1' }, user: { id: 'U1' }, container: { channel_id: 'D1' }, actions: [{ value }] }))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return SELF.fetch('https://state.test/slack/interactions', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}` }, body });
}
type Element = { text: { text: string }; value?: string };
type Posted = { method: string; body: { ts?: string; text: string; blocks: Array<{ type: string; elements?: Array<Element | { text: string }> }> } };
let posted: Posted[] = [];
/** The last post or edit of the message whose fallback text starts so. */
const latest = (prefix: string) => posted.filter((p) => p.body.text?.startsWith(prefix)).at(-1);
const buttons = (p: Posted) => Object.fromEntries(p.body.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements as Element[]).map((e) => [e.text.text, e]));
const context = (p: Posted) => (p.body.blocks.find((b) => b.type === 'context')!.elements![0] as { text: string }).text;

beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables, ...mirrorTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
    (_instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
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
  await env.AUTH_DB.prepare('DELETE FROM slackInstallation').run();
  await env.AUTH_DB.prepare('DELETE FROM slackLink').run();
  await env.AUTH_DB.prepare('INSERT INTO slackInstallation VALUES (?,?,?,?,?,?)').bind('T1', 'B1', await sealToken(env, 'xoxb-test'), 'chat:write,im:write,im:history', 'a', linkedAt).run();
  await env.AUTH_DB.prepare('INSERT INTO slackLink VALUES (?,?,?,?,?,NULL)').bind('T1', 'U1', 'a', 'D1', linkedAt).run();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });

async function boat(name: string, permissions: string[]) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  expect(result.status, JSON.stringify(result.value)).toBe(201);
  return result.value as { token: string; id: string };
}
/** A boat enrolled with `lobstah wharf login --mirror`: mirror and read, no work, no helm. */
const mirrorBoat = () => boat('mac', ['mirror', 'read']);
const ask = { family: 'permission', key: 'decision:home1', stateHash: 'asked-1', sourceAt: '2026-11-20T12:00:00.000Z', title: 'Allow: wrangler deploy',
  summary: 'Run: wrangler deploy\ntrap early-pebble · codex', grounds: 'home', actions: [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }] };
async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
/** The mac's glass snapshot, with the same decision standing in its deck. */
const snapshot = { generatedAt: '2026-11-20T12:00:00.000Z', traps: [], decisions: [], attention: [{ kind: 'decision', key: 'decision:home1', stateHash: 'asked-1', id: 'd-1', lane: 'work', verb: 'decision', ageSecs: 0 }] };
const putSnapshot = async (token: string) => SELF.fetch('https://state.test/v1/accounts/a/mirror/snapshot', {
  method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' }, body: await gzip(JSON.stringify(snapshot)),
});
type Listed = { boat: string; etag: string; unchanged?: true; snapshot?: { attention: unknown[] } };
const listed = async (known = '') => (await (await call(`mirror${known ? `?known=${known}` : ''}`)).json<{ boats: Listed[] }>()).boats;
const storeCard = async (key: string) => (await (await call('cards')).json<GlassCard[]>()).find((c) => c.key === key);
/** Make every source's last restatement, and every end, as old as `ms`. */
const age = async (table: 'card_sources' | 'ends', ms: number) => table === 'card_sources'
  ? sql('UPDATE card_sources SET at=at-?', ms)
  : sql("UPDATE cards SET data=json_set(data,'$.terminal.at',?) WHERE json_extract(data,'$.terminal') IS NOT NULL", new Date(Date.now() - ms).toISOString());

it('a mirror boat’s standing card for home reaches the person linked to home as a DM in the command that stated it', async () => {
  const mac = await mirrorBoat();
  expect((await call('cards', { cards: [ask] }, mac.token)).status).toBe(200);
  // The command that stored the card drains Slack: no timer between the boat's check and the DM.
  await vi.waitFor(() => expect(latest('Permission:')).toBeDefined(), { timeout: 5000 });
  const dm = latest('Permission:')!;
  expect(dm.method).toBe('chat.postMessage');
  expect(context(dm)).toContain('home');
  expect(Object.keys(buttons(dm))).toEqual(['Allow once', 'Allow always', 'No', 'Open in glass']);
  expect(await storeCard('decision:home1')).toMatchObject({ source: `boat:${mac.id}`, grounds: 'home', revision: 1 });
});

it('names each card’s grounds and boat on its Slack context line: the boat that stated it, the boat that claimed a wharf job, or the wharf', async () => {
  const mac = await boat('chriss-macbook-pro', ['mirror', 'read']);
  const decision = { family: 'decision', key: 'decision:home2', stateHash: 'asked-1', sourceAt: '2026-11-20T12:00:00.000Z', title: 'Keep the PR cache across restarts?', grounds: 'home', actions: [{ kind: 'answer', option: 'Keep it' }] };
  expect((await call('cards', { cards: [decision] }, mac.token)).status).toBe(200);
  const fisher = await boat('fisher', ['work', 'helm']);
  expect((await call('helm/take', { session: 'helm' }, fisher.token)).status).toBe(200);
  await call('documents', { id: 'away-choice', kind: 'decision', grounds: 'away', title: 'Ship the away build?', options: ['Ship it'] }, fisher.token);
  await call('documents/away-choice/publish', {}, fisher.token);
  await call('dispatches', { id: 'checkout', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the flaky checkout' }, fisher.token);
  await call('workers/sign-on', { worker: 'worker', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo' }, fisher.token);
  expect((await call('claims', { worker: 'worker' }, fisher.token)).status).toBe(200);
  await deliver(); await deliver();
  expect(context(latest('Decision: Keep the PR cache')!)).toMatch(/^Decision · home · chriss-macbook-pro · Waiting for you/);
  expect(context(latest('Decision: Ship the away build?')!)).toMatch(/^Decision · away · wharf · Waiting for you/);
  expect(context(latest('Job: Fix the flaky checkout')!)).toMatch(/^Job · away · fisher · /);
});

it('an answer from Slack becomes one receipt that only the mirror boat reads and settles', async () => {
  const mac = await mirrorBoat();
  await call('cards', { cards: [ask] }, mac.token); await deliver();
  await press(buttons(latest('Permission:')!)['Allow once']!.value!);
  await press(buttons(latest('Permission:')!)['Allow once']!.value!);
  const receipts = await (await call('cards/answers', undefined, mac.token)).json<CardAnswerReceipt[]>();
  expect(receipts).toEqual([expect.objectContaining({ key: 'decision:home1', stateHash: 'asked-1', action: { kind: 'allow-once' }, state: 'pending' })]);
  expect((await call(`cards/answers/${receipts[0]!.id}`, { state: 'applied', outcome: 'grant g1' }, mac.token)).status).toBe(200);
  expect(await (await call('cards/answers', undefined, mac.token)).json()).toEqual([]);
  expect(await storeCard('decision:home1')).toMatchObject({ relay: { state: 'applied', answer: 'Allow once', outcome: 'grant g1' } });
});

it('lists a mirrored card on the hosted deck once: from the snapshot, never again from the card store', async () => {
  const mac = await mirrorBoat();
  expect((await putSnapshot(mac.token)).status).toBe(200);
  await call('cards', { cards: [ask] }, mac.token);
  const [boat] = await listed();
  expect(boat!.snapshot!.attention).toEqual([expect.objectContaining({ key: 'decision:home1' })]);
  // The hosted glass's wharf part carries no card store: the deck has the snapshot's item only.
  expect(JSON.stringify(await (await call('glass')).json())).not.toContain('decision:home1');
});

it('a mirrored card unrestated for 7 days leaves Slack and the hosted deck, then its rows go; a wharf grounds’ card stays', async () => {
  const mac = await mirrorBoat(), fisher = await boat('fisher', ['work']);
  expect((await putSnapshot(mac.token)).status).toBe(200);
  await call('cards', { cards: [ask] }, mac.token);
  await call('cards', { cards: [{ ...ask, key: 'decision:away1', grounds: 'away', title: 'Allow: git push' }] }, fisher.token);
  await deliver();
  const [held] = await listed();
  // Just short of the TTL nothing lapses.
  await age('card_sources', MIRRORED_CARD_MS - 60_000);
  expect(await runDurableObjectAlarm(env.ACCOUNTS.getByName('a'))).toBe(true);
  expect(await storeCard('decision:home1')).not.toHaveProperty('terminal');
  await age('card_sources', 60_000);
  // The alarm set for the lapse ends the card; its message closes with no button that answers.
  expect(await runDurableObjectAlarm(env.ACCOUNTS.getByName('a'))).toBe(true);
  expect(await storeCard('decision:home1')).toMatchObject({ terminal: { state: 'expired' }, actions: [] });
  await deliver();
  const closed = latest('Permission: Allow: wrangler deploy')!;
  expect(closed.method).toBe('chat.update');
  expect(context(closed)).toContain('Expired');
  expect(Object.values(buttons(closed)).filter((b) => b.value && !b.text.text.includes('glass'))).toEqual([]);
  // The hosted deck: the boat's snapshot comes without its standing items, under a new etag.
  const [lapsed] = await listed(`${held!.boat}:${held!.etag}`);
  expect(lapsed).not.toHaveProperty('unchanged');
  expect(lapsed!.snapshot!.attention).toEqual([]);
  // A wharf grounds' card, unrestated as long, stands as before.
  expect(await storeCard('decision:away1')).not.toHaveProperty('terminal');
  expect(context(latest('Permission: Allow: git push')!)).toContain('Waiting for you');
  // Once its end has shown for LAPSED_CLOSE_MS, the card, its answers and its Slack delivery are deleted.
  const seq = Number((await storeCard('decision:home1'))!.id.slice(1));
  await age('ends', LAPSED_CLOSE_MS);
  await call('cards');
  expect(await sql('SELECT seq FROM cards WHERE seq=?', seq)).toEqual([]);
  expect(await sql('SELECT card FROM card_answers WHERE card=?', seq)).toEqual([]);
  expect(await sql('SELECT card FROM slack_deliveries WHERE card=?', seq)).toEqual([]);
  expect(await sql('SELECT card FROM slack_actions WHERE card=?', seq)).toEqual([]);
  expect(await storeCard('decision:away1')).toBeDefined();
  // The boat back online restates it: it stands again, and its deck items with it.
  await call('cards', { cards: [ask] }, mac.token);
  expect(await storeCard('decision:home1')).not.toHaveProperty('terminal');
  expect((await listed())[0]!.snapshot!.attention).toHaveLength(1);
});
