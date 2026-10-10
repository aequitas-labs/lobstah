import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { digest } from '../src/protocol.js';
import type { Account } from '../src/account.js';
import { WharfBackend } from '../../../packages/core/src/wharf-backend.js';
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
  expect((await call('workers/sign-on', { worker, repo, repoRemote: `github.com/test/${repo}` }, m.token)).status).toBe(200); return m;
}
async function enqueue(id = 'dispatch', forWorker?: string) {
  expect((await call('dispatches', { id, repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'build', ...(forWorker ? { for: forWorker } : {}) })).status).toBe(200);
}
async function claim(token: string, worker = 'worker', retryKey?: string) {
  const res = await call('claims', { worker }, token, retryKey);
  expect(res.status).toBe(200); return res.json<{ dispatch: { id: string }; epoch: number; token: string }>();
}
beforeEach(async () => {
  // New pool shares storage across tests: explicitly delete only test DO data.
  const stub = env.ACCOUNTS.getByName('a');
  await runInDurableObject(stub, async (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'event_details', 'dispatches', 'reports', 'events', 'idem', 'recoveries', 'claims', 'messages', 'files']) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key!='generation'");
    state.storage.sql.exec('INSERT OR IGNORE INTO meta VALUES (?,?)', 'generation', crypto.randomUUID());
  });
  expect((await call('helm/take', { session: 'helm' })).status).toBe(200);
});
it('matches canonical remotes across local nicknames, never matching different remotes with the same nickname', async () => {
  const matching = await boat('matching', 'worker-key');
  expect((await call('workers/sign-on', { worker: 'matching', repo: 'worker-key', repoRemote: 'github.com/test/repo' }, matching.token)).status).toBe(200);
  const foreign = await boat('foreign');
  expect((await call('workers/sign-on', { worker: 'foreign', repo: 'repo', repoRemote: 'github.com/other/repo' }, foreign.token)).status).toBe(200);
  await enqueue();
  expect(await (await call('claims', { worker: 'foreign' }, foreign.token)).json()).toBeNull();
  expect((await claim(matching.token, 'matching')).dispatch.id).toBe('dispatch');
});
it('lists unservable repos and records one event per availability transition, including lease expiry', async () => {
  await enqueue();
  const listed = await (await call('dispatches')).json<{ unservable?: { repo: string; note: string } }[]>();
  expect(listed[0].unservable).toMatchObject({ repo: 'github.com/test/repo', note: expect.stringContaining('no boat online') });
  expect(await (await call('dispatches/dispatch')).json()).toMatchObject({ unservable: listed[0].unservable });
  const before = await (await call('events')).json<{ cursor: string; events: { kind: string; note?: string }[] }>();
  expect(before.events.filter((e) => e.kind === 'unservable')).toEqual([expect.objectContaining({ note: expect.stringContaining('github.com/test/repo') })]);
  expect((await (await call(`events?after=${before.cursor}`)).json<{ events: unknown[] }>()).events).toEqual([]);
  const b = await boat();
  expect((await (await call('dispatches')).json<{ unservable?: unknown }[]>())[0].unservable).toBeUndefined();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => { state.storage.sql.exec('UPDATE workers SET seen=0 WHERE boat=?', b.id); });
  expect((await (await call(`events?after=${before.cursor}`)).json<{ events: { kind: string }[] }>()).events.filter((e) => e.kind === 'unservable')).toHaveLength(1);
  const cursor = (await (await call('events')).json<{ cursor: string }>()).cursor;
  expect((await (await call(`events?after=${cursor}`)).json<{ events: unknown[] }>()).events).toEqual([]);
});
it('local Workers end-to-end: helm enqueues, boat claims, agent renews/uploads/reports, helm wait wakes', async () => {
  const location = { kind: 'wharf' as const, url: 'https://state.test', account: 'a', tokenEnv: 'TEST_TOKEN' };
  const transport: typeof fetch = (input, init) => SELF.fetch(input, init);
  const helm = new WharfBackend(location, pat, { session: 'helm', fetch: transport });
  const m = await boat('e2e');
  const launcher = new WharfBackend(location, m.token, { worker: 'e2e', fetch: transport });
  await helm.enqueue({ id: 'e2e', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'write a report', for: 'e2e', model: 'gpt-6.1-sol' }, 'e2e-enqueue');
  const claim = await launcher.claim('e2e-claim'); expect(claim?.dispatch.id).toBe('e2e');
  const agent = new WharfBackend(location, claim!.token!, { fetch: transport });
  await agent.heartbeat('e2e', 'beat');
  await helm.send('e2e', 'include evidence', 'send');
  const [message] = await agent.messages('e2e'); expect(message.text).toBe('include evidence');
  await agent.receipt('e2e', message.id, 'receipt');
  const file = await agent.upload('e2e', 'report.md', new TextEncoder().encode('# Result\n\nBuilt safely.'), 'upload');
  const cursor = (await helm.events()).cursor;
  const wait = helm.wait(cursor, 5000);
  await agent.report('e2e', { verb: 'done', note: 'finished', evidence: { files: [file], prUrls: ['https://github.com/test/repo/pull/1'] } }, 'finish');
  const wake = await wait; expect(wake.events.some((e) => e.kind === 'done' && e.dispatchId === 'e2e')).toBe(true);
  const [view] = await helm.list(); expect(view.state).toBe('done'); expect(view.status?.evidence?.files).toEqual([file]);
});
it('a paused deadline holds the catch through missing signal; expiry is unknown, never completion', async () => {
  const m = await boat(); const other = await boat('other'); await enqueue(); const r = await claim(m.token);
  await call('dispatches/dispatch/report', { verb: 'paused', waitingOn: 'person', until: new Date(Date.now() + 3600000).toISOString() }, r.token);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => { state.storage.sql.exec('UPDATE dispatches SET lease=0'); });
  expect(await (await call('claims', { worker: 'other' }, other.token)).json()).toBeNull();
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, r.token)).status).toBe(409);
  expect((await call('workers/renew', { worker: 'worker' }, m.token)).status).toBe(200);
  expect((await call('dispatches/dispatch/report', { verb: 'working' }, r.token)).status).toBe(200);
});
it('two workers race a dispatch: one wins; ownership and a single open catch are atomic', async () => {
  const a = await boat('a-worker'); const b = await boat('b-worker'); await enqueue();
  const responses = await Promise.all([call('claims', { worker: 'a-worker' }, a.token), call('claims', { worker: 'b-worker' }, b.token)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const claims = await Promise.all(responses.map((r) => r.json())); expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims[0] ? a : b; const worker = claims[0] ? 'a-worker' : 'b-worker';
  expect((await call('claims', { worker }, winner.token)).status).toBe(409);
});
it('eligible addressed work cannot starve behind a large queue of another worker\'s jobs', async () => {
  const m = await boat();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    state.storage.transactionSync(() => {
      for (let i = 0; i < 1001; i++) {
        const id = `foreign-${i}`;
        state.storage.sql.exec("INSERT INTO dispatches(id,data,state) VALUES (?,?,'queued')", id, JSON.stringify({ id, repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'foreign', for: 'absent' }));
      }
    });
  });
  await enqueue('mine', 'worker'); expect((await claim(m.token)).dispatch.id).toBe('mine');
});
it('idempotent enqueue, claim and report write once and conflicting keys fail', async () => {
  const m = await boat();
  const input = { id: 'dispatch', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'build' };
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
    ['dispatches', { id: 'evil', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'bad' }], ['dispatches/dispatch/cancel', {}],
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
  expect((await call('dispatches', { id: 'late', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'old helm' })).status).toBe(409);
});
it('stores only boat credential hashes and returns a credential only once', async () => {
  const response = await call('boats', { name: 'laptop' }, pat, 'issue');
  const first = await response.json<{ id: string; token: string }>();
  const retry = await (await call('boats', { name: 'laptop' }, pat, 'issue')).json<Record<string, unknown>>(); expect(retry.token).toBeUndefined();
  const hash = await digest(first.token.split('.').at(-1)!);
  await runInDurableObject(env.ACCOUNTS.getByName('a'), async (_instance: Account, state) => {
    expect(state.storage.sql.exec<{ hash: string }>('SELECT hash FROM boats WHERE id=?', first.id).one().hash).toBe(hash);
  });
});
it('rotates a unique named boat credential without losing its identity, repos or sticky work', async () => {
  const a = await boat('laptop'); const other = await boat('other');
  await call('dispatches', { id: 'sticky', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work', boat: a.id });
  const rotated = await (await call('boats', { name: 'LAPTOP' }, pat, 'rotate')).json<{ id: string; name: string; token: string }>();
  expect(rotated).toMatchObject({ id: a.id, name: 'laptop' });
  expect(rotated.token).not.toBe(a.token);
  expect((await call('workers/renew', { worker: 'laptop' }, a.token)).status).toBe(401);
  expect((await call('workers/renew', { worker: 'laptop' }, rotated.token)).status).toBe(200);
  const retry = await (await call('boats', { name: 'laptop' }, pat, 'rotate')).json<{ token?: string }>();
  expect(retry.token).toBeUndefined();
  expect((await call('workers/renew', { worker: 'laptop' }, rotated.token)).status).toBe(200);
  expect(await (await call('claims', { worker: 'other' }, other.token)).json()).toBeNull();
  expect((await claim(rotated.token, 'laptop')).dispatch.id).toBe('sticky');
});
it('revocation leaves boat-addressed work unservable and sticky; rename preserves identity and updates labels', async () => {
  const a = await boat('laptop'); const other = await boat('other');
  await call('dispatches', { id: 'sticky', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work', boat: a.id });
  expect((await call(`boats/${a.id}/revoke`, {})).status).toBe(200);
  expect(await (await call('dispatches/sticky')).json()).toMatchObject({ boat: a.id, boatName: 'laptop', state: 'queued', unservable: { note: expect.stringContaining('credential revoked') } });
  expect(await (await call('claims', { worker: 'other' }, other.token)).json()).toBeNull();
  expect((await call(`boats/${a.id}/rename`, { name: 'desk' })).status).toBe(200);
  expect(await (await call('dispatches/sticky')).json()).toMatchObject({ boat: a.id, boatName: 'desk', unservable: { note: expect.stringContaining('boat desk') } });
  const events = (await (await call('events')).json<{ events: { dispatchId?: string; boatName?: string; note?: string }[] }>()).events.filter((e) => e.dispatchId === 'sticky');
  expect(events.every((e) => e.boatName === 'desk')).toBe(true);
  expect(events.some((e) => e.note?.includes('boat laptop'))).toBe(false);
  expect((await call(`boats/${a.id}/rename`, { name: 'other' })).status).toBe(409);
  expect((await call('boats', { name: 'unsafe name' })).status).toBe(400);
});
it('explicit boat removal refuses open targets and claims, and works only after cancellation', async () => {
  const a = await boat('laptop');
  await call('dispatches', { id: 'sticky', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work', boat: a.id });
  const remove = () => SELF.fetch(`https://state.test/v1/accounts/a/boats/${a.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${pat}`, 'Idempotency-Key': `remove-${++key}` } });
  expect((await remove()).status).toBe(409);
  await claim(a.token, 'laptop');
  expect((await remove()).status).toBe(409);
  await call('dispatches/sticky/cancel', {});
  expect((await remove()).status).toBe(200);
  expect((await (await call('boats')).json<unknown[]>())).toEqual([]);
  expect((await call('workers/renew', { worker: 'laptop' }, a.token)).status).toBe(401);
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
it('person sessions cannot sign on, claim or renew a worker and explain boat enrolment', async () => {
  for (const path of ['workers/sign-on', 'workers/renew', 'claims']) {
    const res = await call(path, { worker: 'person-worker', repo: 'repo', repoRemote: 'github.com/test/repo' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('enrol this machine as a boat') });
  }
});
it('steering layers imply lower layers while work remains independent', async () => {
  const issue = async (name: string, permissions: string[]) => {
    const res = await call('boats', { name, permissions, confirmAdmin: permissions.includes('admin') });
    expect(res.status).toBe(201); return res.json<{ id: string; token: string }>();
  };
  const read = await issue('read', ['read']); const work = await issue('work', ['work']);
  const helm = await issue('steer', ['helm']); const admin = await issue('admin', ['admin']);
  await enqueue();
  for (const path of ['boats', 'dispatches', 'dispatches/dispatch', 'events', 'dispatches/dispatch/messages', 'dispatches/dispatch/recoveries']) {
    for (const token of [read.token, helm.token, admin.token]) expect((await call(path, undefined, token)).status).toBe(200);
    expect((await call(path, undefined, work.token)).status).toBe(403);
  }
  for (const token of [read.token, helm.token, admin.token]) {
    expect((await call('workers/sign-on', { worker: 'w', repo: 'repo', repoRemote: 'github.com/test/repo' }, token)).status).toBe(403);
    expect((await call('claims', { worker: 'w' }, token)).status).toBe(403);
    expect((await call('workers/renew', { worker: 'w' }, token)).status).toBe(403);
  }
  expect((await call('workers/sign-on', { worker: 'w', repo: 'repo', repoRemote: 'github.com/test/repo' }, work.token)).status).toBe(200);
  expect((await call('workers/renew', { worker: 'w' }, work.token)).status).toBe(200);
  for (const path of ['workers/sign-on', 'workers/renew', 'claims']) expect((await call(path, { worker: 'w', repo: 'repo', repoRemote: 'github.com/test/repo', boat: read.id }, work.token)).status).toBe(400);
  for (const token of [read.token, work.token]) {
    for (const [path, body] of [['helm/take', { session: 'helm', take: true }], ['helm/renew', {}], ['helm/release', {}], ['dispatches', { id: 'blocked' }], ['dispatches/dispatch/messages', { text: 'blocked' }], ['dispatches/dispatch/cancel', {}]] as const) expect((await call(path, body, token)).status).toBe(403);
  }
  // Knowing the current session ID does not inherit another principal's seat.
  expect((await call('helm/take', { session: 'helm' }, helm.token)).status).toBe(409);
  expect((await call('helm/take', { session: 'helm', take: true }, helm.token)).status).toBe(200);
  expect((await call('helm/renew', {}, helm.token)).status).toBe(200);
  expect((await call('dispatches/dispatch/messages', { text: 'steer' }, helm.token)).status).toBe(200);
  expect((await call('dispatches/dispatch/cancel', {}, helm.token)).status).toBe(200);
  expect((await call('helm/release', {}, helm.token)).status).toBe(200);
  expect((await call('helm/take', { session: 'helm' }, admin.token)).status).toBe(200);
  expect((await call('helm/renew', {}, admin.token)).status).toBe(200);
  expect((await call('dispatches', { id: 'admin-job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' }, admin.token)).status).toBe(200);
  expect((await call('dispatches/admin-job/messages', { text: 'admin steer' }, admin.token)).status).toBe(200);
  expect((await call('dispatches/admin-job/cancel', {}, admin.token)).status).toBe(200);
  expect((await call('helm/release', {}, admin.token)).status).toBe(200);
  for (const token of [read.token, work.token, helm.token]) {
    for (const [path, body] of [['boats', { name: 'blocked' }], [`boats/${read.id}/permissions`, { permissions: ['work'] }], [`boats/${read.id}/rename`, { name: 'new' }], [`boats/${read.id}/revoke`, {}]] as const) expect((await call(path, body, token)).status).toBe(403);
    expect((await SELF.fetch(`https://state.test/v1/accounts/a/boats/${read.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `remove-${++key}` } })).status).toBe(403);
    expect((await SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `delete-${++key}` } })).status).toBe(403);
  }
  expect((await call('boats', { name: 'child' }, admin.token)).status).toBe(201);
  expect((await call(`boats/${read.id}/permissions`, { permissions: ['read', 'work'] }, admin.token)).status).toBe(200);
  expect((await call(`boats/${read.id}/rename`, { name: 'new' }, admin.token)).status).toBe(200);
  expect((await call(`boats/${read.id}/revoke`, {}, admin.token)).status).toBe(200);
  expect((await SELF.fetch(`https://state.test/v1/accounts/a/boats/${read.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'admin-remove' } })).status).toBe(200);
  for (let i = 0; i < 2; i++) expect((await SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'admin-delete' } })).status).toBe(200);
});
it('validates permissions, requires explicit admin confirmation, and rejects replay after a permission is removed', async () => {
  for (const permissions of [['root'], 'work', ['admin']]) expect((await call('boats', { name: 'bad', permissions })).status).toBe(400);
  const m = await boat();
  expect((await call(`boats/${m.id}/permissions`, { permissions: ['admin'] })).status).toBe(400);
  const granted = await call(`boats/${m.id}/permissions`, { permissions: ['work', 'helm', 'read'] });
  expect(granted.status).toBe(200);
  expect(await granted.json()).toEqual({ id: m.id, permissions: ['work', 'helm'] });
  expect((await call('helm/take', { session: 'helm', take: true }, m.token)).status).toBe(200);
  const input = { id: 'dispatch', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' };
  expect((await call('dispatches', input, m.token, 'formerly-allowed')).status).toBe(200);
  // Revoking the steering layer also removes its implied read authority.
  expect((await call(`boats/${m.id}/permissions`, { permissions: ['work'] })).status).toBe(200);
  expect((await call('dispatches', input, m.token, 'formerly-allowed')).status).toBe(403);
  expect((await call('helm/renew', {}, m.token)).status).toBe(403);
  expect((await call('events', undefined, m.token)).status).toBe(403);
  expect((await call('dispatches', undefined, m.token)).status).toBe(403);
  // An explicit lower layer restores only read, not helm.
  expect((await call(`boats/${m.id}/permissions`, { permissions: ['work', 'read'] })).status).toBe(200);
  expect((await call('dispatches', undefined, m.token)).status).toBe(200);
  expect((await call('helm/renew', {}, m.token)).status).toBe(403);
  // Job authority remains scoped to its epoch, but cannot extend a removed work grant.
  const receipt = await claim(m.token);
  expect((await call(`boats/${m.id}/permissions`, { permissions: [] })).status).toBe(200);
  expect((await call('workers/renew', { worker: 'worker' }, m.token)).status).toBe(403);
  expect((await call('dispatches/dispatch/heartbeat', {}, receipt.token)).status).toBe(403);
  expect((await call('dispatches/dispatch/report', { verb: 'done' }, receipt.token)).status).toBe(200);
});
