import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { sealToken } from '../src/slack-install.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfDocument, WharfHumanRequest } from '../../../packages/core/src/backend-model.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `act-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
/** An interaction as Slack sends it: a signed form body with one `payload` field. */
async function interact(payload: Record<string, unknown>) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`, ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}`;
  return SELF.fetch('https://state.test/slack/interactions', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': signature, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
}
const press = (value: string, who: { user?: string; channel?: string } = {}) =>
  interact({ type: 'block_actions', trigger_id: 'trigger-1', team: { id: 'T1' }, user: { id: who.user ?? 'U1' }, container: { channel_id: who.channel ?? 'D1' }, actions: [{ action_id: 'card-action-0', value }] });
const submit = (handle: string, value: string) =>
  interact({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' }, view: { callback_id: 'card-answer', private_metadata: handle, state: { values: { answer: { answer: { value } } } } } });
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type Element = { text: { text: string }; value?: string; url?: string };
type Posted = { method: string; body: { text: string; blocks: Array<{ type: string; elements?: Element[] }>; trigger_id?: string; view?: { private_metadata: string; callback_id: string } } };
let posted: Posted[] = [];
/** The latest message of the card whose fallback starts so, and its buttons by label. */
const buttons = (prefix: string) => {
  const message = posted.filter((p) => p.body.text?.startsWith(prefix)).at(-1)!;
  return Object.fromEntries(message.body.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements!).map((e) => [e.text.text, e]));
};
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
async function decision(id: string) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: `boat-${id}`, permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  const b = result.value as { token: string };
  expect((await call('helm/take', { session: 'seat' }, b.token, 'seat')).status).toBe(200);
  expect((await call('documents', { id, kind: 'decision', title: 'Keep the PR cache across restarts?', options: ['Keep the cache', 'Drop the cache'] }, b.token, 'seat')).status).toBe(200);
  expect((await call(`documents/${id}/publish`, {}, b.token, 'seat')).status).toBe(200);
  await deliver();
  return b;
}
const doc = async (id: string) => (await call(`documents/${id}`)).json<WharfDocument>();

it('an option pressed in Slack answers the decision as the linked person; the same message closes; a later press answers nothing', async () => {
  await decision('pick');
  const before = buttons('Decision:');
  expect(Object.keys(before)).toEqual(['Keep the cache', 'Drop the cache', 'Answer…', 'Open in glass']);
  expect((await press(before['Drop the cache']!.value!)).status).toBe(200);
  expect((await doc('pick')).answer).toMatchObject({ option: 'Drop the cache', by: 'a' });
  await deliver();
  expect(posted.at(-1)).toMatchObject({ method: 'chat.update' });
  expect(Object.keys(buttons('Decision:'))).toEqual(['Open in glass']);
  // The other option, pressed on the old message, is about a state that no longer stands.
  expect((await press(before['Keep the cache']!.value!)).status).toBe(200);
  expect((await doc('pick')).answer).toMatchObject({ option: 'Drop the cache' });
});

it('only the linked person, in their own DM, with a handle the wharf gave them, acts', async () => {
  await decision('pick');
  const { 'Drop the cache': drop } = buttons('Decision:');
  await press(drop!.value!, { user: 'U2' });
  await press(drop!.value!, { channel: 'C1' });
  await press(`h${'0'.repeat(32)}`);
  await press('not-a-handle');
  expect((await doc('pick')).answer).toBeUndefined();
  // A handle past its time asks for the card again.
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_i: Account, state) => state.storage.sql.exec('UPDATE slack_actions SET expires=0'));
  await press(drop!.value!);
  expect((await doc('pick')).answer).toBeUndefined();
});

it('Answer… opens a form; what is sent there is the answer; an empty one is refused in the form', async () => {
  await decision('pick');
  const { 'Answer…': write } = buttons('Decision:');
  await press(write!.value!);
  const opened = posted.find((p) => p.method === 'views.open')!;
  expect(opened.body).toMatchObject({ trigger_id: 'trigger-1', view: { callback_id: 'card-answer', private_metadata: write!.value } });
  expect(await (await submit(write!.value!, '   ')).json()).toMatchObject({ response_action: 'errors' });
  expect(await (await submit(write!.value!, 'Keep it, but cap it at a day')).json()).toEqual({ response_action: 'clear' });
  expect((await doc('pick')).answer).toMatchObject({ text: 'Keep it, but cap it at a day', by: 'a' });
});

it('opening a card from its message is seeing it, at that state', async () => {
  await decision('pick');
  const { 'Open in glass': open } = buttons('Decision:');
  expect(open!.url).toMatch(/^https:\/\/glass\.test\/#card\/c\d+$/);
  await press(open!.value!);
  expect((await doc('pick')).ack).toMatchObject({ by: 'slack' });
  expect((await doc('pick')).answer).toBeUndefined();
});

it('a worker’s question takes a message for the helm from its form, through the helm', async () => {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: 'qboat', permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  const b = result.value as { token: string };
  await call('helm/take', { session: 'seat' }, b.token, 'seat');
  await call('dispatches', { id: 'job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Fix the checkout' }, b.token, 'seat');
  await call('workers/sign-on', { worker: 'worker', repo: 'repo', repoRemote: 'github.com/test/repo' }, b.token);
  const claim = await (await call('claims', { worker: 'worker' }, b.token)).json<{ token: string }>();
  await call('dispatches/job/report', { verb: 'needs-decision', note: 'Which branch?' }, claim.token);
  await deliver();
  const { 'Message the helm…': message } = buttons('Question:');
  await press(message!.value!);
  expect(await (await submit(message!.value!, 'Use main')).json()).toEqual({ response_action: 'clear' });
  const requests = await (await call('requests')).json<WharfHumanRequest[]>();
  expect(requests).toContainEqual(expect.objectContaining({ kind: 'message', dispatch: 'job', text: 'Use main', by: 'a', state: 'queued' }));
});
