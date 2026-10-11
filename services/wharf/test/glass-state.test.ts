import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfDocument, WharfHumanRequest } from '../../../packages/core/src/backend-model.js';
import { WharfBackend } from '../../../packages/core/src/wharf-backend.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm', key = `glass-${++sequence}`, account = 'a') => SELF.fetch(`https://state.test/v1/accounts/${account}/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
  });
  const objects = await env.FILES.list({ prefix: 'a/' }); if (objects.objects.length) await env.FILES.delete(objects.objects.map((o) => o.key));
});
async function helmBoat() {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: 'test-boat', permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  expect(result.status).toBe(201); const boat = result.value as { token: string; id: string };
  expect((await call('helm/take', { session: 'boat-seat' }, boat.token, 'boat-seat')).status).toBe(200);
  return boat;
}
async function dispatch(token: string, session: string) {
  expect((await call('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'work' }, token, session)).status).toBe(200);
}
async function document(id: string, kind: string, token: string, session: string) {
  expect((await call('documents', { id, kind, title: 'Choose a direction', options: kind === 'decision' ? ['One', 'Two'] : [] }, token, session)).status).toBe(200);
}
async function upload(id: string, name: string, bytes: string, token: string, session: string) {
  const res = await SELF.fetch(`https://state.test/v1/accounts/a/documents/${id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `upload-${++sequence}`, 'X-File-Name': name }, body: bytes });
  expect(res.status, await res.clone().text()).toBe(200); return (await res.json<{ id: string }>()).id;
}

it.each([false, true])('person cancel fences a worker without taking a helm seat (live=$0)', async (live) => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat');
  expect((await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, boat.token)).status).toBe(200);
  const receipt = await (await call('claims', { worker: 'worker' }, boat.token)).json<{ token: string; epoch: number }>();
  if (!live) await sql("DELETE FROM meta WHERE key='helm'");
  const before = await sql("SELECT value FROM meta WHERE key='helm'");
  const cursor = (await (await call('events')).json<{ cursor: string }>()).cursor;
  expect((await call('dispatches/job/cancel', {})).status).toBe(200);
  expect(await sql("SELECT value FROM meta WHERE key='helm'")).toEqual(before);
  expect((await call('dispatches/job/report', { verb: 'done' }, receipt.token)).status).toBe(409);
  expect(await sql('SELECT state,epoch FROM dispatches WHERE id=?', 'job')).toEqual([{ state: 'cancelled', epoch: receipt.epoch + 1 }]);
  const events = await (await call(`events?after=${cursor}`)).json<{ events: { kind: string; note?: string }[] }>();
  expect(events.events).toContainEqual(expect.objectContaining({ kind: 'cancelled', note: 'cancelled by person:a' }));
  if (live) expect((await call('helm/renew', {}, boat.token, 'boat-seat')).status).toBe(200);
  expect((await call('dispatches/job/cancel', {}, person, 'helm', undefined, 'b')).status).toBe(403);
});

it('person send stays queued without a helm and expires visibly, never firing late', async () => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat'); await sql("DELETE FROM meta WHERE key='helm'");
  const payload = { id: 'request', kind: 'message', dispatch: 'job', text: 'Please retry' };
  const created = await call('requests', payload, person, 'helm', 'same'); expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ state: 'queued', waitingForHelm: true });
  expect((await call('requests', payload, person, 'helm', 'same')).status).toBe(200);
  expect(await sql('SELECT count(*) AS n FROM human_requests')).toEqual([{ n: 1 }]);
  expect(await sql('SELECT count(*) AS n FROM messages')).toEqual([{ n: 0 }]);
  expect((await call('dispatches/job/messages', { text: 'cannot bypass seat' })).status).toBe(409);
  await sql("UPDATE human_requests SET data=json_set(data,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id='request'");
  expect(await (await call('requests')).json()).toContainEqual(expect.objectContaining({ id: 'request', state: 'expired' }));
  await call('helm/take', { session: 'boat-seat' }, boat.token, 'boat-seat');
  expect((await call('requests/request/receipt', {}, boat.token, 'boat-seat')).status).toBe(409);
  expect((await call('requests/request/execute', {}, boat.token, 'boat-seat')).status).toBe(409);
  expect(await sql('SELECT count(*) AS n FROM messages')).toEqual([{ n: 0 }]);
});

it('only the leased helm receipts and executes a live human message, once', async () => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat');
  await call('requests', { id: 'request', kind: 'message', dispatch: 'job', text: 'Answer' });
  expect((await call('requests/request/receipt', {})).status).toBe(409);
  expect((await call('requests/request/execute', {}, boat.token, 'boat-seat')).status).toBe(409);
  expect((await call('requests/request/receipt', {}, boat.token, 'boat-seat')).status).toBe(200);
  expect((await call('requests/request/execute', {}, boat.token, 'boat-seat', 'execute')).status).toBe(200);
  expect((await call('requests/request/execute', {}, boat.token, 'boat-seat', 'execute')).status).toBe(200);
  expect(await sql('SELECT text FROM messages')).toEqual([{ text: 'Answer' }]);
  expect((await call('requests', { id: 'forged', kind: 'message', dispatch: 'job', text: 'No' }, boat.token)).status).toBe(403);
});

it('a card answer emits a decision-answer event and does not touch the live helm', async () => {
  const boat = await helmBoat(); await document('card', 'decision', boat.token, 'boat-seat');
  expect((await call('documents/card/publish', {}, boat.token, 'boat-seat')).status).toBe(200);
  const before = await sql("SELECT value FROM meta WHERE key='helm'");
  const cursor = (await (await call('events', undefined, boat.token)).json<{ cursor: string }>()).cursor;
  expect((await call('documents/card/answer', { option: 'Missing' })).status).toBe(400);
  expect((await call('documents/card/answer', { option: 'One', text: 'Do this' }, person, 'helm', 'answer')).status).toBe(200);
  expect((await call('documents/card/answer', { option: 'One', text: 'Do this' }, person, 'helm', 'answer')).status).toBe(200);
  expect((await call('documents/card/answer', { option: 'Two' })).status).toBe(409);
  expect(await sql("SELECT value FROM meta WHERE key='helm'")).toEqual(before);
  const events = await (await call(`events?after=${cursor}`, undefined, boat.token)).json<{ events: { kind: string; note?: string }[] }>();
  expect(events.events).toContainEqual(expect.objectContaining({ kind: 'decision-answer', note: 'card' }));
  expect(await (await call('documents/card', undefined, boat.token)).json()).toMatchObject({ answer: { by: 'a', option: 'One', text: 'Do this' } });
});

it('publishes owned Markdown and attachments in R2, refusing another document’s file', async () => {
  const boat = await helmBoat(); await document('report', 'report', boat.token, 'boat-seat'); await document('other', 'report', boat.token, 'boat-seat');
  const markdown = await upload('report', 'report.md', '# Report\n<script>literal</script>', boat.token, 'boat-seat');
  expect((await call('documents/other/publish', { markdown }, boat.token, 'boat-seat')).status).toBe(400);
  expect((await call('documents/report/publish', { markdown }, boat.token, 'boat-seat')).status).toBe(200);
  const data = await (await call('documents/report')).json<WharfDocument>(); expect(data.markdown?.id).toBe(markdown);
  const file = await call(`documents/report/files/${markdown}`); expect(file.status).toBe(200);
  expect(file.headers.get('content-type')).toBe('application/octet-stream'); expect(file.headers.get('x-content-type-options')).toBe('nosniff'); expect(file.headers.get('content-disposition')).toBe('attachment');
  expect(new TextDecoder().decode(await file.arrayBuffer())).toContain('<script>literal</script>');
  expect((await call(`documents/other/files/${markdown}`)).status).toBe(404);
  expect((await call(`documents/report/files/${markdown}`, undefined, person, 'helm', undefined, 'b')).status).toBe(403);
});

it('shows boat repos, check-in and trap harness/current job without exposing hashes', async () => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat');
  await call('workers/sign-on', { worker: 'trap', repo: 'repo', repoRemote: 'github.com/test/repo', harness: 'codex', session: 'session' }, boat.token);
  await call('claims', { worker: 'trap' }, boat.token);
  const result = await call('glass'); expect(result.status).toBe(200);
  const glass = await result.json<Record<string, unknown>>();
  expect(glass.boats).toContainEqual(expect.objectContaining({ id: boat.id, name: 'test-boat', repos: ['github.com/test/repo'], lastCheckIn: expect.any(String) }));
  expect(glass.workers).toContainEqual(expect.objectContaining({ id: 'trap', harness: 'codex', session: 'session', boat: boat.id, current: 'job' }));
  expect(JSON.stringify(glass)).not.toContain('hash'); expect(JSON.stringify(glass)).not.toContain(boat.token);
});

it('person trap requests wait for a helm and are bounded, without launching anything', async () => {
  const boat = await helmBoat(); await sql("DELETE FROM meta WHERE key='helm'");
  const result = await call('requests', { id: 'start', kind: 'trap-request', boat: boat.id, repo: 'github.com/test/repo' });
  expect(result.status).toBe(200); expect(await result.json<WharfHumanRequest>()).toMatchObject({ kind: 'trap-request', state: 'queued', waitingForHelm: true });
  expect((await call('requests', { id: 'bad', kind: 'trap-request', boat: boat.id, repo: '/user/path' })).status).toBe(400);
  expect(await sql('SELECT count(*) AS n FROM workers')).toEqual([{ n: 0 }]);
});

it('only the helm authorizes a start; only its addressed work boat can consume it, once', async () => {
  const boat = await helmBoat();
  const otherResult = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person,
    method: 'POST', path: 'boats', body: { name: 'other-boat', permissions: ['work'] }, key: `other-${++sequence}` })));
  const other = otherResult.value as { token: string };
  await call('requests', { id: 'start', kind: 'trap-request', boat: boat.id, repo: 'github.com/test/repo' });
  expect((await call('requests/start/execute', {})).status).toBe(409);
  expect((await call('requests/start/start', {}, boat.token)).status).toBe(409);
  await call('requests/start/receipt', {}, boat.token, 'boat-seat');
  expect(await (await call('requests/start/execute', {}, boat.token, 'boat-seat')).json()).toMatchObject({ state: 'authorized' });
  expect(await (await call('requests/starts', undefined, other.token)).json()).toEqual([]);
  expect((await call('requests/start/start', {}, other.token)).status).toBe(403);
  expect((await call('requests/start/start', {})).status).toBe(403);
  await sql('UPDATE boat_permissions SET permissions=? WHERE boat=?', '["work"]', boat.id);
  expect(await (await call('requests/starts', undefined, boat.token)).json()).toContainEqual(expect.objectContaining({ id: 'start', state: 'authorized' }));
  expect((await call('requests/start/start', {}, boat.token, 'unused', 'consume')).status).toBe(200);
  expect((await call('requests/start/start', {}, boat.token, 'unused', 'consume')).status).toBe(200);
  expect((await call('requests/start/start', {}, boat.token)).status).toBe(409);
  expect(await (await call('requests/starts', undefined, boat.token)).json()).toEqual([]);
  expect(await sql('SELECT count(*) AS n FROM events WHERE kind=?', 'trap-start-accepted')).toEqual([{ n: 1 }]);
});

it('an authorized start expires while the boat is offline, and a refused repo remains visible', async () => {
  const boat = await helmBoat();
  for (const id of ['late', 'foreign']) {
    await call('requests', { id, kind: 'trap-request', boat: boat.id, repo: 'github.com/test/repo' });
    await call(`requests/${id}/receipt`, {}, boat.token, 'boat-seat'); await call(`requests/${id}/execute`, {}, boat.token, 'boat-seat');
  }
  await sql("UPDATE human_requests SET data=json_set(data,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id='late'");
  expect((await call('requests/late/start', {}, boat.token)).status).toBe(409);
  expect(await (await call('requests/late')).json()).toMatchObject({ state: 'expired' });
  expect((await call('requests/foreign/start', { refused: 'repo is not configured on this boat' }, boat.token)).status).toBe(200);
  expect(await (await call('requests/foreign')).json()).toMatchObject({ state: 'fulfilled', outcome: 'repo is not configured on this boat' });
  expect(await sql('SELECT count(*) AS n FROM workers')).toEqual([{ n: 0 }]);
});

it('read boats cannot author cards, answer for the human or enqueue human requests; dispatch tokens see only their own job', async () => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat');
  await document('card', 'decision', boat.token, 'boat-seat'); await call('documents/card/publish', {}, boat.token, 'boat-seat');
  expect((await call('documents/card/answer', { option: 'One' }, boat.token, 'boat-seat')).status).toBe(403);
  expect((await call('documents/card/answer/extra', { option: 'One' })).status).toBe(404);
  await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, boat.token);
  const claim = await (await call('claims', { worker: 'worker' }, boat.token)).json<{ token: string }>();
  for (const route of ['glass', 'workers', 'documents', 'requests', 'dispatches/job/detail']) expect((await call(route, undefined, claim.token)).status).toBe(403);
  await sql('UPDATE boat_permissions SET permissions=? WHERE boat=?', JSON.stringify(['work', 'read']), boat.id);
  expect((await call('glass', undefined, boat.token)).status).toBe(200);
  expect((await call('documents', { id: 'forbidden', kind: 'decision', title: 'No' }, boat.token)).status).toBe(403);
  expect((await call('documents/card/files', { name: 'not-uploaded' }, boat.token)).status).toBe(403);
  expect((await call('requests', { id: 'forbidden', kind: 'message', dispatch: 'job', text: 'No' }, boat.token)).status).toBe(403);
  expect((await call('documents', { id: 'no-seat', kind: 'decision', title: 'No' })).status).toBe(409);
  expect((await call('documents/card/publish', {})).status).toBe(409);
});

it('account deletion clears documents, human requests, worker metadata and their R2 files', async () => {
  const boat = await helmBoat(); await dispatch(boat.token, 'boat-seat');
  await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo', harness: 'claude' }, boat.token);
  await document('report', 'report', boat.token, 'boat-seat');
  const markdown = await upload('report', 'report.md', '# Report', boat.token, 'boat-seat');
  await call('documents/report/publish', { markdown }, boat.token, 'boat-seat');
  await call('requests', { id: 'request', kind: 'message', dispatch: 'job', text: 'No late send' });
  const deleted = await SELF.fetch('https://state.test/v1/accounts/a/', { method: 'DELETE', headers: { Authorization: `Bearer ${person}`, 'Idempotency-Key': 'glass-delete' } });
  expect(deleted.status).toBe(200);
  for (const table of glassTables) expect(await sql(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
  expect((await env.FILES.list({ prefix: 'a/' })).objects).toEqual([]);
  expect((await call('glass', undefined, boat.token)).status).toBe(410);
});
it('a boat with read lists the standing documents its attention feed needs, a work-only boat none, and neither answers for the person', async () => {
  const helm = await helmBoat();
  const issue = async (name: string, permissions: string[]) => {
    const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
    expect(result.status).toBe(201); return (result.value as { token: string }).token;
  };
  const reader = await issue('pet-boat', ['work', 'read']), worker = await issue('work-boat', ['work']);
  await dispatch(helm.token, 'boat-seat');
  for (const id of ['card', 'answered', 'gone', 'draft']) expect((await call('documents', { id, kind: 'decision', title: `Decision ${id}`, options: ['One'], ...(id === 'card' ? { dispatch: 'job' } : {}) }, helm.token, 'boat-seat')).status).toBe(200);
  for (const id of ['card', 'answered', 'gone']) expect((await call(`documents/${id}/publish`, {}, helm.token, 'boat-seat')).status).toBe(200);
  expect((await call('documents/answered/answer', { option: 'One' })).status).toBe(200);
  expect((await call('documents/gone/withdraw', {}, helm.token, 'boat-seat')).status).toBe(200);
  const location = { kind: 'wharf' as const, url: 'https://state.test', account: 'a', tokenEnv: 'UNUSED' };
  const feed = new WharfBackend(location, reader, { fetch: (input, init) => SELF.fetch(input as string, init) });
  const listed = await feed.documents();
  expect(listed.map((d) => ({ ...d, at: 'at' })).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
    { id: 'answered', kind: 'decision', title: 'Decision answered', at: 'at', answered: true },
    { id: 'card', kind: 'decision', title: 'Decision card', at: 'at', dispatch: 'job' },
  ]);
  expect(feed.glass).toBe('https://glass.test');
  await expect(new WharfBackend(location, worker, { fetch: (input, init) => SELF.fetch(input as string, init) }).documents()).rejects.toMatchObject({ status: 403 });
  const before = await sql('SELECT data FROM documents ORDER BY id');
  expect((await call('documents/card/answer', { option: 'One' }, reader)).status).toBe(403);
  expect(await sql('SELECT data FROM documents ORDER BY id')).toEqual(before);
});
/** A boat by name with exactly these permissions; its credential. */
async function issue(name: string, permissions: string[]) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  expect(result.status).toBe(201); return (result.value as { token: string }).token;
}
/** The helm's job, claimed by a worker on that boat: the dispatch token that reports for it. */
async function claimed(helm: { token: string }) {
  await dispatch(helm.token, 'boat-seat');
  expect((await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, helm.token)).status).toBe(200);
  return (await (await call('claims', { worker: 'worker' }, helm.token)).json<{ token: string }>()).token;
}
const quiet = async () => ({ events: await sql('SELECT count(*) AS n FROM events'), helm: await sql("SELECT value FROM meta WHERE key='helm'") });
it('a document ack is one seen-mark by a read boat or the person: the first stands, a work-only boat and a dispatch token are refused', async () => {
  const helm = await helmBoat(), reader = await issue('pet-boat', ['work', 'read']), worker = await issue('work-boat', ['work']), agent = await claimed(helm);
  await document('card', 'decision', helm.token, 'boat-seat'); await document('draft', 'decision', helm.token, 'boat-seat'); await document('gone', 'decision', helm.token, 'boat-seat');
  for (const id of ['card', 'gone']) expect((await call(`documents/${id}/publish`, {}, helm.token, 'boat-seat')).status).toBe(200);
  expect((await call('documents/gone/withdraw', {}, helm.token, 'boat-seat')).status).toBe(200);
  const before = await quiet();
  // Refused: no read layer, a dispatch token, nothing standing to see, and a request without its key.
  expect((await call('documents/card/ack', {}, worker)).status).toBe(403);
  expect((await call('documents/card/ack', {}, agent)).status).toBe(403);
  expect((await call('documents/draft/ack', {}, reader)).status).toBe(409);
  expect((await call('documents/gone/ack', {}, reader)).status).toBe(409);
  expect((await call('documents/missing/ack', {}, reader)).status).toBe(404);
  expect((await call('documents/card/ack/extra', {}, reader)).status).toBe(404);
  expect((await SELF.fetch('https://state.test/v1/accounts/a/documents/card/ack', { method: 'POST', headers: { Authorization: `Bearer ${reader}` }, body: '{}' })).status).toBe(400);
  expect((await (await call('documents/card', undefined, reader)).json<WharfDocument>()).ack).toBeUndefined();
  // The pet's boat acks, with no helm lease and no seat header that means anything.
  const first = await call('documents/card/ack', {}, reader, 'no-such-seat'); expect(first.status).toBe(200);
  const ack = (await first.json<WharfDocument>()).ack!; expect(ack).toEqual({ at: expect.any(String), by: 'boat:pet-boat' });
  // The first ack stands: the person's, the helm's and the same boat's later acks return it.
  for (const token of [person, helm.token, reader]) expect((await (await call('documents/card/ack', {}, token)).json<WharfDocument>()).ack).toEqual(ack);
  // Every read of the document carries it; an answer does not disturb it.
  expect((await (await call('documents', undefined, reader)).json<WharfDocument[]>()).find((d) => d.id === 'card')!.ack).toEqual(ack);
  expect((await (await call('glass', undefined, reader)).json<{ documents: WharfDocument[] }>()).documents.find((d) => d.id === 'card')!.ack).toEqual(ack);
  expect((await call('documents/card/answer', { option: 'One' })).status).toBe(200);
  expect(await (await call('documents/card', undefined, reader)).json<WharfDocument>()).toMatchObject({ ack, answer: { option: 'One' } });
  // No event (the answer made the only one), so no helm wakes for an ack; the helm seat is as it was.
  const after = await quiet(); expect(after.helm).toEqual(before.helm); expect(after.events[0]!.n).toBe(Number(before.events[0]!.n) + 1);
  // The person acks first when they are first.
  expect((await call('documents/draft/publish', {}, helm.token, 'boat-seat')).status).toBe(200);
  expect((await (await call('documents/draft/ack', {})).json<WharfDocument>()).ack).toMatchObject({ by: 'person' });
});
it('a job ack is keyed on the status it saw: a new report stands unacknowledged, and stale, work-only and dispatch-token acks are refused', async () => {
  type Job = { status?: { at: string; verb: string }; ack?: { status: string; at: string; by: string } };
  const helm = await helmBoat(), reader = await issue('pet-boat', ['work', 'read']), worker = await issue('work-boat', ['work']), agent = await claimed(helm);
  const job = async (token = reader) => (await call('dispatches/job', undefined, token)).json<Job>();
  // Nothing reported yet: nothing to have seen.
  expect((await call('dispatches/job/ack', { at: new Date().toISOString() }, reader)).status).toBe(409);
  expect((await call('dispatches/job/report', { verb: 'needs-decision', note: 'which?' }, agent)).status).toBe(200);
  const asked = (await job()).status!.at; const before = await quiet();
  expect((await call('dispatches/job/ack', { at: asked }, worker)).status).toBe(403);
  // A job's own dispatch token is in scope for the job and still may not ack it.
  expect((await call('dispatches/job/ack', { at: asked }, agent)).status).toBe(403);
  expect((await call('dispatches/job/ack', {}, reader)).status).toBe(409);
  expect((await call('dispatches/job/ack', { at: '2020-01-01T00:00:00.000Z' }, reader)).status).toBe(409);
  expect((await call('dispatches/missing/ack', { at: asked }, reader)).status).toBe(404);
  expect((await job()).ack).toBeUndefined();
  const first = await call('dispatches/job/ack', { at: asked }, reader); expect(first.status).toBe(200);
  const ack = await first.json<Job['ack']>(); expect(ack).toEqual({ status: asked, at: expect.any(String), by: 'boat:pet-boat' });
  expect(await (await call('dispatches/job/ack', { at: asked })).json()).toEqual(ack);
  // The job's reads carry it: the one read, the list a boat polls, and the glass's detail.
  expect((await job()).ack).toEqual(ack);
  expect((await (await call('dispatches', undefined, reader)).json<Job[]>())[0]!.ack).toEqual(ack);
  expect((await (await call('dispatches/job/detail', undefined, reader)).json<Job>()).ack).toEqual(ack);
  expect(await quiet()).toEqual(before);
  // The job reports again: that is new to see. The old ack no longer shows and cannot be repeated.
  expect((await call('dispatches/job/report', { verb: 'done', note: 'landed' }, agent)).status).toBe(200);
  const landed = (await job()).status!.at; expect(landed).not.toBe(asked); expect((await job()).ack).toBeUndefined();
  expect((await call('dispatches/job/ack', { at: asked }, reader)).status).toBe(409);
  expect(await (await call('dispatches/job/ack', { at: landed })).json()).toMatchObject({ status: landed, by: 'person' });
  expect((await job()).ack).toMatchObject({ status: landed, by: 'person' });
});
it('the boat’s client acks through both routes and reads the acks back in its poll', async () => {
  const helm = await helmBoat(), reader = await issue('pet-boat', ['work', 'read']), agent = await claimed(helm);
  await document('card', 'decision', helm.token, 'boat-seat'); expect((await call('documents/card/publish', {}, helm.token, 'boat-seat')).status).toBe(200);
  expect((await call('dispatches/job/report', { verb: 'needs-decision', note: 'which?' }, agent)).status).toBe(200);
  const location = { kind: 'wharf' as const, url: 'https://state.test', account: 'a', tokenEnv: 'UNUSED' };
  const boat = new WharfBackend(location, reader, { fetch: (input, init) => SELF.fetch(input as string, init) });
  const asked = (await boat.list())[0]!.status!.at;
  const seen = await boat.ackDocument('card', 'client-doc'); expect(seen).toEqual({ at: expect.any(String), by: 'boat:pet-boat' });
  const job = await boat.ackDispatch('job', asked, 'client-job'); expect(job).toEqual({ status: asked, at: expect.any(String), by: 'boat:pet-boat' });
  expect((await boat.documents())[0]).toMatchObject({ id: 'card', ack: seen }); expect((await boat.list())[0]!.ack).toEqual(job);
  // The same key again is the same ack; an ack of a status the job has left is refused.
  expect(await boat.ackDocument('card', 'client-doc')).toEqual(seen);
  await expect(boat.ackDispatch('job', '2020-01-01T00:00:00.000Z', 'client-stale')).rejects.toMatchObject({ status: 409 });
  await expect(new WharfBackend(location, agent, { fetch: (input, init) => SELF.fetch(input as string, init) }).ackDispatch('job', asked, 'client-agent')).rejects.toMatchObject({ status: 403 });
});
