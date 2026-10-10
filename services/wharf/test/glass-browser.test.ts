import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { wharfAuth } from '../src/auth.js';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { authFixtures } from './auth-fixture.js';
let cookie: string, account: string, token: string, sequence = 0;
const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const browser = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) => SELF.fetch(`https://glass.test/api/glass${path ? '/' + path : ''}`, {
  method, headers: { Cookie: cookie, Origin: 'https://glass.test', 'Idempotency-Key': `browser-${++sequence}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const api = (path: string, body?: unknown) => SELF.fetch(`https://state.test/v1/accounts/${account}/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': 'live', 'Idempotency-Key': `api-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = (statement: string) => runInDurableObject(env.ACCOUNTS.getByName(account), (_instance: Account, state) => state.storage.sql.exec(statement).toArray());
beforeAll(async () => {
  await authFixtures();
  const start = await SELF.fetch('https://glass.test/api/auth/sign-in/social', { method: 'POST', headers: { Origin: 'https://glass.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'github', callbackURL: 'https://glass.test/' }) });
  expect(start.status).toBe(200);
  const state = new URL((await start.json<{ url: string }>()).url).searchParams.get('state')!;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'browser-stub', token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 123, login: 'browser-test', name: 'Browser Test', email: 'browser@example.test', avatar_url: null });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'browser@example.test', primary: true, verified: true }]);
    throw new Error('unexpected OAuth destination');
  });
  try {
    const callback = await SELF.fetch(`https://glass.test/api/auth/callback/github?code=stub&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { Cookie: cookies(start) } });
    expect(callback.status).toBe(302); cookie = cookies(callback);
    const session = (await wharfAuth(env).api.getSession({ headers: new Headers({ Cookie: cookie }) }))!;
    account = session.user.id; token = session.session.token;
  } finally { outbound.mockRestore(); }
});
beforeEach(async () => {
  await runInDurableObject(env.ACCOUNTS.getByName(account), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
  });
  await env.AUTH_DB.exec('DELETE FROM rateLimit');
});
async function job() {
  expect((await api('helm/take', { session: 'live' })).status).toBe(200);
  expect((await api('dispatches', { id: 'job', brief: 'Work', repo: 'repo', repoRemote: 'github.com/test/repo' })).status).toBe(200);
}
it('serves the same bundled look on the glass host only, with nonce CSP and no credentials', async () => {
  const page = await SELF.fetch('https://glass.test/'); expect(page.status).toBe(200);
  const content = await page.text(); expect(content).toContain('spyglass'); expect(content).toContain('--lobstah');
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('cache-control')).toBe('no-store'); expect(content).not.toContain(token);
  expect((await SELF.fetch('https://glass.test/device')).status).toBe(200);
  expect((await SELF.fetch('https://state.test/')).status).toBe(404);
});
it('requires its cookie, not an API bearer, and derives the account rather than trusting a selector', async () => {
  await job();
  expect((await SELF.fetch('https://glass.test/api/glass')).status).toBe(401);
  expect((await browser('', undefined, 'GET', { Authorization: `Bearer ${token}` })).status).toBe(401);
  const list = await browser('dispatches?account=b'); expect(list.status).toBe(200); expect(await list.json()).toContainEqual(expect.objectContaining({ id: 'job' }));
  expect((await browser('accounts/b/dispatches')).status).toBe(404);
  expect((await SELF.fetch(`https://state.test/v1/accounts/${account}/dispatches`, { headers: { Cookie: cookie } })).status).toBe(401);
});
it('accepts cookie-scoped wake hints without a helm lease and fences expired sessions', async () => {
  const response = await browser('wake', undefined, 'GET', { Upgrade: 'websocket' }); expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept();
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  const previous = await env.AUTH_DB.prepare('SELECT expiresAt FROM session WHERE token=?').bind(token).first<{ expiresAt: number }>();
  await env.AUTH_DB.prepare('UPDATE session SET expiresAt=0 WHERE token=?').bind(token).run();
  // A private fixture emits an account event after expiry: no content is delivered.
  await env.ACCOUNTS.getByName(account).handle(JSON.stringify({ account, helm: true, personId: account, token, path: 'helm/take', method: 'POST', body: { session: 'fixture' }, key: 'expired-wake' }));
  await closed; expect(socket.readyState).not.toBe(WebSocket.OPEN);
  await env.AUTH_DB.prepare('UPDATE session SET expiresAt=? WHERE token=?').bind(previous!.expiresAt, token).run();
});
it('rejects cross-origin or missing-origin writes, malformed and oversized bodies', async () => {
  await job();
  const body = { id: 'message', kind: 'message', dispatch: 'job', text: 'hello' };
  expect((await browser('requests', body, 'POST', { Origin: 'https://evil.test' })).status).toBe(403);
  expect((await SELF.fetch('https://glass.test/api/glass/requests', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) })).status).toBe(403);
  expect((await SELF.fetch('https://glass.test/api/glass/requests', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://glass.test' }, body: '{' })).status).toBe(400);
  expect((await SELF.fetch('https://glass.test/api/glass/requests', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://glass.test' }, body: 'x'.repeat(65537) })).status).toBe(413);
});
it('cannot take the helm, author, enroll or grant; queued steering and owner cancel preserve the seat', async () => {
  await job(); const before = await sql("SELECT value FROM meta WHERE key='helm'");
  for (const route of ['helm/take', 'helm/renew', 'documents', 'boats', 'boats/boat/grants', 'boats/boat/rename', 'requests/message/execute', 'dispatches/job/messages']) expect((await browser(route, {})).status).toBe(404);
  const message = await browser('requests', { id: 'message', kind: 'message', dispatch: 'job', text: 'hello' }, 'POST', { 'X-Lobstah-Helm': 'live' });
  expect(message.status).toBe(200); expect(await message.json()).toMatchObject({ state: 'queued' });
  expect(await sql('SELECT text FROM messages')).toEqual([]);
  expect((await browser('dispatches/job/cancel', {})).status).toBe(200);
  expect(await sql("SELECT value FROM meta WHERE key='helm'")).toEqual(before);
  expect(await sql("SELECT state FROM dispatches WHERE id='job'")).toEqual([{ state: 'cancelled' }]);
});
it('answers a published card and downloads only the document’s own files with nosniff', async () => {
  await job();
  expect((await api('documents', { id: 'card', kind: 'decision', title: 'Choose', options: ['yes'] })).status).toBe(200);
  const upload = await SELF.fetch(`https://state.test/v1/accounts/${account}/documents/card/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': 'live', 'Idempotency-Key': 'md', 'X-File-Name': 'detail.md' }, body: '<script>literal</script>' });
  const file = await upload.json<{ id: string }>(); expect(upload.status).toBe(200);
  expect((await api('documents/card/publish', { markdown: file.id })).status).toBe(200);
  const before = await sql("SELECT value FROM meta WHERE key='helm'");
  expect((await browser('documents/card/answer', { option: 'yes' })).status).toBe(200);
  expect(await sql("SELECT value FROM meta WHERE key='helm'")).toEqual(before);
  const download = await browser(`documents/card/files/${file.id}`); expect(download.status).toBe(200);
  expect(download.headers.get('x-content-type-options')).toBe('nosniff'); expect(download.headers.get('content-disposition')).toBe('attachment'); expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('<script>literal</script>');
  expect((await browser(`documents/another/files/${file.id}`)).status).toBe(404);
  expect((await browser(`documents/card/files/${file.id}/extra`)).status).toBe(404);
});
it('requires a separate in-page deletion confirmation and then removes identity and account data', async () => {
  await job();
  expect((await browser('account', {}, 'DELETE')).status).toBe(400);
  expect((await browser('account', { confirm: true }, 'DELETE')).status).toBe(200);
  expect(await env.AUTH_DB.prepare('SELECT id FROM user WHERE id=?').bind(account).first()).toBeNull();
  expect((await browser('dispatches')).status).toBe(401);
  expect(await sql('SELECT id FROM dispatches')).toEqual([]);
});
