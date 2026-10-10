import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfDocument, WharfHumanRequest } from '../../../packages/core/src/backend-model.js';

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
