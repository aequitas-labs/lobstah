import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { digest } from '../src/protocol.js';
import type { Account } from '../src/account.js';
let key = 0;
const pat = 'test-helm-a';
async function call(path: string, body?: unknown, token = pat, idempotency = `key-${++key}`, account = 'a') {
  return SELF.fetch(`https://state.test/v1/accounts/${account}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotency, 'X-Lobstah-Helm': 'helm' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function machine(worker = 'worker', repo = 'repo') {
  const issued = await call('machines', { name: worker }); expect(issued.status).toBe(201);
  const m = await issued.json<{ id: string; token: string }>();
  expect((await call('workers/sign-on', { worker, repo }, m.token)).status).toBe(200); return m;
}
async function enqueue(id = 'dispatch', forWorker?: string) {
  expect((await call('dispatches', { id, repo: 'repo', brief: 'build', ...(forWorker ? { for: forWorker } : {}) })).status).toBe(200);
}
async function claim(token: string, worker = 'worker', retryKey?: string) {
  const res = await call('claims', { worker }, token, retryKey);
  expect(res.status).toBe(200); return res.json<{ dispatch: { id: string }; epoch: number; token: string }>();
}
beforeEach(async () => {
  // New pool shares storage across tests: explicitly delete only test DO data.
  const stub = env.ACCOUNTS.getByName('a');
  await runInDurableObject(stub, async (_instance: Account, state) => {
    for (const table of ['machines', 'workers', 'dispatches', 'reports', 'events', 'idem', 'recoveries', 'claims']) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key!='generation'");
  });
  expect((await call('helm/take', { session: 'helm' })).status).toBe(200);
});
it('two workers race a dispatch: one wins; ownership and a single open catch are atomic', async () => {
  const a = await machine('a-worker'); const b = await machine('b-worker'); await enqueue();
  const responses = await Promise.all([call('claims', { worker: 'a-worker' }, a.token), call('claims', { worker: 'b-worker' }, b.token)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const claims = await Promise.all(responses.map((r) => r.json())); expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims[0] ? a : b; const worker = claims[0] ? 'a-worker' : 'b-worker';
  expect((await call('claims', { worker }, winner.token)).status).toBe(409);
});
it('idempotent enqueue, claim and report write once and conflicting keys fail', async () => {
  const m = await machine();
  const input = { id: 'dispatch', repo: 'repo', brief: 'build' };
  expect((await call('dispatches', input, pat, 'enqueue')).status).toBe(200);
  expect((await call('dispatches', input, pat, 'enqueue')).status).toBe(200);
  expect((await call('dispatches', { ...input, brief: 'changed' }, pat, 'enqueue')).status).toBe(409);
  const first = await claim(m.token, 'worker', 'claim'); const again = await claim(m.token, 'worker', 'claim'); expect(again).toEqual(first);
  for (let i = 0; i < 2; i++) expect((await call('dispatches/dispatch/report', { verb: 'done', evidence: { prUrls: ['https://github.com/test/repo/pull/1'] } }, first.token, 'done')).status).toBe(200);
  const events = await (await call('events')).json<{ events: { kind: string }[] }>();
  expect(events.events.filter((e) => e.kind === 'done')).toHaveLength(1);
});
it('machine credentials cannot perform any helm action or read dispatch content; agent tokens cannot claim', async () => {
  const m = await machine(); await enqueue(); const receipt = await claim(m.token);
  for (const [path, body] of [
    ['dispatches', { id: 'evil', repo: 'repo', brief: 'bad' }], ['dispatches/dispatch/cancel', {}],
    ['helm/take', { session: 'evil', take: true }], ['helm/renew', {}], ['helm/release', {}],
    ['machines', { name: 'evil' }], [`machines/${m.id}/revoke`, {}],
  ] as const) expect((await call(path, body, m.token)).status).toBe(403);
  for (const path of ['dispatches', 'dispatches/dispatch', 'events', 'machines']) expect((await call(path, undefined, m.token)).status).toBe(403);
  expect((await call('claims', { worker: 'worker' }, receipt.token)).status).toBe(403);
  await enqueue('second'); expect((await call('dispatches/second', undefined, receipt.token)).status).toBe(403);
  expect((await call('dispatches', undefined, pat, undefined, 'b')).status).toBe(403);
});
it('revocation is immediate for machines, while issued agent leases end at their normal deadline', async () => {
  const m = await machine(); await enqueue(); const receipt = await claim(m.token);
  expect((await call(`machines/${m.id}/revoke`, {})).status).toBe(200);
  expect((await call('workers/renew', { worker: 'worker' }, m.token)).status).toBe(401);
  // A revoked machine cannot extend its agent's original deadline.
  expect((await call('dispatches/dispatch/report', { verb: 'working' }, receipt.token)).status).toBe(200);
});
it('expired and stale epochs cannot report; recovery preserves a result without finalising the replacement', async () => {
  const a = await machine(); const b = await machine('replacement'); await enqueue(); const old = await claim(a.token);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    state.storage.sql.exec('UPDATE dispatches SET lease=0 WHERE id=?', 'dispatch');
  });
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, old.token)).status).toBe(409);
  const next = await claim(b.token, 'replacement'); expect(next.epoch).toBe(old.epoch + 1);
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, old.token)).status).toBe(409);
  expect((await call('dispatches/dispatch/recovery', { verb: 'done', note: 'preserved work' }, old.token)).status).toBe(200);
  const view = await (await call('dispatches/dispatch')).json<{ state: string }>(); expect(view.state).toBe('active');
});
it('addressed work is sticky and a fresh helm cannot be displaced implicitly', async () => {
  const m = await machine(); await enqueue('addressed', 'absent');
  expect(await (await call('claims', { worker: 'worker' }, m.token)).json()).toBeNull();
  expect((await call('helm/take', { session: 'other' })).status).toBe(409);
  expect((await call('helm/take', { session: 'other', take: true })).status).toBe(200);
  expect((await call('dispatches', { id: 'late', repo: 'repo', brief: 'old helm' })).status).toBe(409);
});
it('stores only machine credential hashes and returns a credential only once', async () => {
  const response = await call('machines', { name: 'laptop' }, pat, 'issue');
  const first = await response.json<{ id: string; token: string }>();
  const retry = await (await call('machines', { name: 'laptop' }, pat, 'issue')).json<Record<string, unknown>>(); expect(retry.token).toBeUndefined();
  const hash = await digest(first.token);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    expect(state.storage.sql.exec<{ hash: string }>('SELECT hash FROM machines WHERE id=?', first.id).one().hash).toBe(hash);
  });
});
