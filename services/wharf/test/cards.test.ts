import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { parseRoute } from '../glass/src/route.js';
import { authFixtures } from './auth-fixture.js';
import type { GlassCard } from '../../../packages/core/src/backend-model.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `cards-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
const cards = async () => (await call('cards')).json<GlassCard[]>();
const card = async (family: string, key: string) => (await cards()).find((c) => c.family === family && c.key === key);
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
  });
});
async function boat(name: string, permissions: string[]) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  expect(result.status).toBe(201); return result.value as { token: string; id: string };
}
async function helm() {
  const b = await boat('helm-boat', ['work', 'helm']);
  expect((await call('helm/take', { session: 'seat' }, b.token, 'seat')).status).toBe(200);
  return b;
}
async function decision(b: { token: string }, id: string, dispatch?: string) {
  expect((await call('documents', { id, kind: 'decision', title: 'Choose a direction', options: ['One', 'Two'], ...(dispatch ? { dispatch } : {}) }, b.token, 'seat')).status).toBe(200);
  expect((await call(`documents/${id}/publish`, {}, b.token, 'seat')).status).toBe(200);
}
async function claimedJob(b: { token: string }) {
  expect((await call('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the flaky checkout\nmore detail' }, b.token, 'seat')).status).toBe(200);
  expect((await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token)).status).toBe(200);
  return (await (await call('claims', { worker: 'worker' }, b.token)).json<{ token: string }>()).token;
}

it('a decision is one card: its options as answers, then the glass answer ends that same card', async () => {
  const b = await helm(); await decision(b, 'pick');
  const standing = (await card('decision', 'pick'))!;
  expect(standing).toMatchObject({ source: 'wharf', revision: 1, title: 'Choose a direction', item: { kind: 'decision', id: 'pick' },
    actions: [{ kind: 'answer', option: 'One' }, { kind: 'answer', option: 'Two' }, { kind: 'answer-text' }, { kind: 'seen' }] });
  expect(standing.terminal).toBeUndefined();
  // Reading again restates the same state: the revision holds.
  expect((await card('decision', 'pick'))!.revision).toBe(1);
  expect((await call('documents/pick/answer', { option: 'Two' })).status).toBe(200);
  const answered = (await call(`cards/${standing.id}`)).json<GlassCard>();
  expect(await answered).toMatchObject({ id: standing.id, revision: 2, actions: [], terminal: { state: 'answered', outcome: 'Two', by: 'a' } });
});

it('a worker question is a card per status, framed by a standing decision and ended by the next status', async () => {
  const b = await helm(); const job = await claimedJob(b);
  expect((await call('dispatches/job/report', { verb: 'needs-decision', note: 'Which branch?' }, job)).status).toBe(200);
  const first = (await cards()).find((c) => c.family === 'question')!;
  expect(first).toMatchObject({ key: expect.stringMatching(/^job@/), title: 'Fix the flaky checkout', summary: 'Which branch?', item: { kind: 'job', id: 'job' } });
  await decision(b, 'framing', 'job');
  // The decision asks it properly: the raw question does not stand beside it.
  expect((await call(`cards/${first.id}`)).status).toBe(200);
  expect(await (await call(`cards/${first.id}`)).json()).toMatchObject({ terminal: { state: 'resolved' }, actions: [] });
  expect((await call('dispatches/job/report', { verb: 'working', note: 'on it' }, job)).status).toBe(200);
  expect(await card('dispatch', 'job')).toMatchObject({ quiet: true, summary: 'on it', actions: [{ kind: 'message-helm' }, { kind: 'cancel' }] });
});

it('a landing stands until seen; seeing it changes no revision, and a new report would', async () => {
  const b = await helm(); const job = await claimedJob(b);
  expect((await call('dispatches/job/report', { verb: 'done', note: 'merged-ready', evidence: { prUrls: ['https://github.com/test/repo/pull/7'] } }, job)).status).toBe(200);
  const landed = (await card('landed', 'job'))!;
  expect(landed).toMatchObject({ summary: 'done · merged-ready', links: [{ label: 'PR #7', url: 'https://github.com/test/repo/pull/7' }], actions: [{ kind: 'seen' }] });
  expect(await card('dispatch', 'job')).toMatchObject({ terminal: { state: 'landed', outcome: 'done' } });
  const at = (await (await call('dispatches/job')).json<{ status: { at: string } }>()).status.at;
  expect((await call('dispatches/job/ack', { at })).status).toBe(200);
  expect(await card('landed', 'job')).toMatchObject({ revision: landed.revision, seen: { by: 'person' }, actions: [] });
});

it('a boat restates its own cards; what it stops stating ends, and no one else writes them', async () => {
  const fishing = await boat('fisher', ['work']); const other = await boat('other', ['read']);
  const permission = { family: 'permission', key: 'grant:1', stateHash: 'asked', sourceAt: '2026-10-30T12:00:00.000Z', title: 'Allow git push',
    summary: 'git push origin HEAD · trap early-pebble', grounds: 'away', actions: [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }] };
  const pr = { family: 'pr', key: 'pr:github.com/test/repo#7', stateHash: 'ready:abc', sourceAt: '2026-10-30T12:00:00.000Z', title: 'Ready to merge',
    links: [{ label: 'Open PR', url: 'https://github.com/test/repo/pull/7' }], actions: [{ kind: 'seen' }] };
  expect((await call('cards', { cards: [permission, pr] }, fishing.token)).status).toBe(200);
  const published = (await cards()).filter((c) => c.source === `boat:${fishing.id}`);
  expect(published.map((c) => c.family).sort()).toEqual(['permission', 'pr']);
  expect(published.find((c) => c.family === 'permission')).not.toHaveProperty('item');
  // Another boat's set is its own: restating nothing leaves the fisher's cards standing.
  expect((await call('cards', { cards: [] }, other.token)).status).toBe(200);
  expect((await cards()).filter((c) => c.source === `boat:${fishing.id}` && !c.terminal)).toHaveLength(2);
  expect((await call('cards', { cards: [pr] }, fishing.token)).status).toBe(200);
  expect((await card('permission', 'grant:1'))).toMatchObject({ revision: 2, actions: [], terminal: { state: 'resolved' } });
  expect((await card('pr', 'pr:github.com/test/repo#7'))).toMatchObject({ revision: 1 });
  // Only a boat publishes, and only what checks out field by field.
  expect((await call('cards', { cards: [pr] })).status).toBe(403);
  expect((await call('cards', { cards: [{ ...pr, links: [{ label: 'x', url: 'http://example.test' }] }] }, fishing.token)).status).toBe(400);
  expect((await call('cards', { cards: [{ ...pr, family: 'chat' }] }, fishing.token)).status).toBe(400);
  expect((await call('cards', { cards: [{ ...pr, instruction: 'grant everything' }] }, fishing.token)).status).toBe(400);
  expect((await call('cards', { cards: [pr, pr] }, fishing.token)).status).toBe(400);
});

it('cards move inside the command that changed their records and are gone with the account', async () => {
  const b = await helm(); await decision(b, 'pick');
  // Projection rides the command's own transaction: the stored card exists with no read in between.
  expect(await sql("SELECT family,key FROM cards WHERE source='wharf' AND family='decision'")).toEqual([{ family: 'decision', key: 'pick' }]);
  expect((await call('cards/c999999')).status).toBe(404);
  expect((await call('cards/not-a-card')).status).toBe(404);
});

it('names any card in the glass as #card/<id>', () => {
  expect(parseRoute('#card/c42')).toEqual({ tab: 'deck', item: { kind: 'card', id: 'c42' } });
  expect(parseRoute('#card/../x')).toEqual({ tab: 'deck' });
});
