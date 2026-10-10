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
async function boat(worker = 'worker', repo = 'repo') {
  const issued = await call('boats', { name: worker }); expect(issued.status).toBe(201);
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
    for (const table of ['boats', 'workers', 'dispatches', 'reports', 'events', 'idem', 'recoveries', 'claims', 'messages', 'files']) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key!='generation'");
    state.storage.sql.exec('INSERT OR IGNORE INTO meta VALUES (?,?)', 'generation', crypto.randomUUID());
  });
  expect((await call('helm/take', { session: 'helm' })).status).toBe(200);
});
it('two workers race a dispatch: one wins; ownership and a single open catch are atomic', async () => {
  const a = await boat('a-worker'); const b = await boat('b-worker'); await enqueue();
  const responses = await Promise.all([call('claims', { worker: 'a-worker' }, a.token), call('claims', { worker: 'b-worker' }, b.token)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const claims = await Promise.all(responses.map((r) => r.json())); expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims[0] ? a : b; const worker = claims[0] ? 'a-worker' : 'b-worker';
  expect((await call('claims', { worker }, winner.token)).status).toBe(409);
});
it('idempotent enqueue, claim and report write once and conflicting keys fail', async () => {
  const m = await boat();
  const input = { id: 'dispatch', repo: 'repo', brief: 'build' };
  expect((await call('dispatches', input, pat, 'enqueue')).status).toBe(200);
  expect((await call('dispatches', input, pat, 'enqueue')).status).toBe(200);
  expect((await call('dispatches', { ...input, brief: 'changed' }, pat, 'enqueue')).status).toBe(409);
  const first = await claim(m.token, 'worker', 'claim'); const again = await claim(m.token, 'worker', 'claim'); expect(again).toEqual(first);
  for (let i = 0; i < 2; i++) expect((await call('dispatches/dispatch/report', { verb: 'done', evidence: { prUrls: ['https://github.com/test/repo/pull/1'] } }, first.token, 'done')).status).toBe(200);
  const events = await (await call('events')).json<{ events: { kind: string }[] }>();
  expect(events.events.filter((e) => e.kind === 'done')).toHaveLength(1);
});
it('boat credentials cannot perform any helm action or read dispatch content; agent tokens cannot claim', async () => {
  const m = await boat(); await enqueue(); const receipt = await claim(m.token);
  for (const [path, body] of [
    ['dispatches', { id: 'evil', repo: 'repo', brief: 'bad' }], ['dispatches/dispatch/cancel', {}],
    ['helm/take', { session: 'evil', take: true }], ['helm/renew', {}], ['helm/release', {}],
    ['boats', { name: 'evil' }], [`boats/${m.id}/revoke`, {}],
  ] as const) expect((await call(path, body, m.token)).status).toBe(403);
  for (const path of ['dispatches', 'dispatches/dispatch', 'events', 'boats']) expect((await call(path, undefined, m.token)).status).toBe(403);
  expect((await call('claims', { worker: 'worker' }, receipt.token)).status).toBe(403);
  await enqueue('second'); expect((await call('dispatches/second', undefined, receipt.token)).status).toBe(403);
  expect((await call('dispatches', undefined, pat, undefined, 'b')).status).toBe(403);
});
it('revocation is immediate for boats, while issued agent leases end at their normal deadline', async () => {
  const m = await boat(); await enqueue(); const receipt = await claim(m.token);
  expect((await call(`boats/${m.id}/revoke`, {})).status).toBe(200);
  expect((await call('workers/renew', { worker: 'worker' }, m.token)).status).toBe(401);
  // A revoked boat cannot extend its agent's original deadline.
  expect((await call('dispatches/dispatch/report', { verb: 'working' }, receipt.token)).status).toBe(200);
});
it('expired and stale epochs cannot report; recovery preserves a result without finalising the replacement', async () => {
  const a = await boat(); const b = await boat('replacement'); await enqueue(); const old = await claim(a.token);
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
  const m = await boat(); await enqueue('addressed', 'absent');
  expect(await (await call('claims', { worker: 'worker' }, m.token)).json()).toBeNull();
  expect((await call('helm/take', { session: 'other' })).status).toBe(409);
  expect((await call('helm/take', { session: 'other', take: true })).status).toBe(200);
  expect((await call('dispatches', { id: 'late', repo: 'repo', brief: 'old helm' })).status).toBe(409);
});
it('stores only boat credential hashes and returns a credential only once', async () => {
  const response = await call('boats', { name: 'laptop' }, pat, 'issue');
  const first = await response.json<{ id: string; token: string }>();
  const retry = await (await call('boats', { name: 'laptop' }, pat, 'issue')).json<Record<string, unknown>>(); expect(retry.token).toBeUndefined();
  const hash = await digest(first.token);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    expect(state.storage.sql.exec<{ hash: string }>('SELECT hash FROM boats WHERE id=?', first.id).one().hash).toBe(hash);
  });
});
it('reading a message does not receipt it; done waits for explicit receipt', async () => {
  const m = await boat(); await enqueue(); const r = await claim(m.token);
  await call('dispatches/dispatch/messages', { text: 'new instruction' });
  const messages = await (await call('dispatches/dispatch/messages', undefined, r.token)).json<{ id: string }[]>();
  expect(messages).toHaveLength(1);
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, r.token)).status).toBe(409);
  expect((await call(`dispatches/dispatch/messages/${messages[0].id}/receipt`, {}, r.token)).status).toBe(200);
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, r.token)).status).toBe(200);
});
it('files are scoped, retryable downloads, never executable pages; deletion removes rows and files', async () => {
  const m = await boat(); await enqueue(); const r = await claim(m.token);
  const upload = () => SELF.fetch('https://state.test/v1/accounts/a/dispatches/dispatch/files', {
    method: 'POST', headers: { Authorization: `Bearer ${r.token}`, 'Idempotency-Key': 'file', 'X-File-Name': 'report.html' }, body: '<script>never run</script>',
  });
  const first = await upload(); expect(first.status).toBe(200); const f = await first.json<{ id: string }>();
  expect(await (await upload()).json()).toEqual({ id: f.id, bytes: 26 });
  const path = `dispatches/dispatch/files/${f.id}`;
  expect((await call(path, undefined, m.token)).status).toBe(403);
  expect((await call(path, undefined, r.token, undefined, 'b')).status).toBe(403);
  const download = await call(path); expect(download.headers.get('Content-Disposition')).toBe('attachment');
  expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('<script>never run</script>');
  expect((await call(path, undefined, 'test-helm-b')).status).toBe(403);
  expect((await SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${m.token}`, 'Idempotency-Key': 'no-delete' } })).status).toBe(403);
  for (let i = 0; i < 2; i++) {
    const res = await SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${pat}`, 'Idempotency-Key': 'delete' } });
    expect(res.status).toBe(200);
  }
  expect((await env.FILES.list({ prefix: 'a/' })).objects).toEqual([]);
  expect((await call('events')).status).toBe(410);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM dispatches').one().n).toBe(0);
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM files').one().n).toBe(0);
  });
});
it('account deletion racing an upload leaves no orphan object', async () => {
  const m = await boat(); await enqueue(); const r = await claim(m.token);
  const responses = await Promise.all([
    SELF.fetch('https://state.test/v1/accounts/a/dispatches/dispatch/files', { method: 'POST', headers: { Authorization: `Bearer ${r.token}`, 'Idempotency-Key': 'race-upload' }, body: 'racing file' }),
    SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${pat}`, 'Idempotency-Key': 'race-delete' } }),
  ]);
  expect([200, 410]).toContain(responses[0].status); expect(responses[1].status).toBe(200);
  expect((await env.FILES.list({ prefix: 'a/' })).objects).toEqual([]);
});
