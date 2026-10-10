import { env, SELF } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { getMigrations } from 'better-auth/db/migration';
import { authOrigins, wharfAuth } from '../src/auth.js';
import { authFixtures } from './auth-fixture.js';

it('refuses a shared glass/API host or non-origin deployment settings', () => {
  expect(() => authOrigins({ ...env, API_ORIGIN: env.GLASS_ORIGIN })).toThrow('distinct origins');
  for (const GLASS_ORIGIN of ['https://glass.test/path', 'https://person@glass.test', 'http://remote.test']) {
    expect(() => authOrigins({ ...env, GLASS_ORIGIN })).toThrow('invalid wharf origin');
  }
});

it.each([{ githubId: 123, allowed: true }, { githubId: 999, allowed: false }])('GitHub admission and device sessions on native D1: $githubId, allowed=$allowed', async ({ githubId, allowed }) => {
  const auth = wharfAuth(env);
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  const request = (path: string, body: unknown, cookie?: string) => new Request(`https://glass.test/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://glass.test', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  const cookies = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const social = await SELF.fetch(request('sign-in/social', { provider: 'github', callbackURL: 'https://glass.test/' }));
  expect(social.status).toBe(200);
  const { url } = await social.json<{ url: string }>();
  expect(new URL(url).hostname).toBe('github.com');
  const state = new URL(url).searchParams.get('state')!;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'stub-provider-token', token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id: githubId, login: 'invited', name: 'Invited', email: `invited-${githubId}@example.test`, avatar_url: null });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: `invited-${githubId}@example.test`, primary: true, verified: true }]);
    throw new Error(`Unexpected outbound destination: ${url}`);
  });
  try {
    const callback = await SELF.fetch(new Request(`https://glass.test/api/auth/callback/github?code=stub-code&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { Cookie: cookies(social) } }));
    expect(callback.status).toBe(302);
    if (!allowed) {
      expect(callback.headers.get('location')).toContain('invite_required');
      expect(await env.AUTH_DB.prepare('SELECT id FROM user WHERE email=?').bind(`invited-${githubId}@example.test`).first()).toBeNull();
      return;
    }
    expect(callback.headers.get('location')).toBe('https://glass.test/');
    expect(callback.headers.getSetCookie().some((c) => c.includes('HttpOnly') && c.includes('Secure') && !/Domain=/i.test(c))).toBe(true);
    const cookie = cookies(callback);
    const browser = (await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) }))!;
    const issued = await SELF.fetch(new Request('https://state.test/v1/auth/device/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'lobstah-cli', account: browser.user.id, name: 'laptop' }) }));
    expect(issued.status).toBe(200);
    const code = await issued.json<{ device_code: string; user_code: string }>();
    const verification = await SELF.fetch(new Request(`https://glass.test/api/auth/device?user_code=${code.user_code}`, { headers: { Cookie: cookie } }));
    expect(verification.status).toBe(200);
    expect((await SELF.fetch(request('wharf/approve', { userCode: code.user_code, name: 'laptop', requestedPermissions: ['work', 'read'], permissions: ['work', 'read'] }, cookie))).status).toBe(200);
    const token = await SELF.fetch(new Request('https://state.test/v1/auth/device/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'lobstah-cli', device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) }));
    expect(token.status).toBe(200);
    const session = await token.json<{ token: string; account: string }>();
    expect(token.headers.has('set-cookie')).toBe(false);
    expect(session.token).toMatch(new RegExp(`^b\\.${browser.user.id}\\.`));
    expect(session.account).toBe(browser.user.id);
    expect(await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${session.token}` }) })).toBeNull();
    expect((await SELF.fetch(`https://state.test/v1/accounts/${session.account}/dispatches`, { headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(200);
  } finally { outbound.mockRestore(); }
});

it('accepts exactly the configured glass origin, and API credentials are bearer-only and account-bound', async () => {
  await authFixtures();
  const call = (url: string, headers: Record<string, string>) => SELF.fetch(url, { headers });
  const url = 'https://state.test/v1/accounts/a/dispatches';
  const good = await call(url, { Authorization: 'Bearer test-helm-a', Origin: 'https://glass.test' });
  expect(good.status).toBe(200); expect(good.headers.get('Access-Control-Allow-Origin')).toBe('https://glass.test');
  expect((await call(url, { Authorization: 'Bearer test-helm-a', Origin: 'https://foreign.test' })).status).toBe(403);
  expect((await call(url, { Authorization: 'Bearer test-helm-a', Origin: 'https://glass.test.evil.test' })).status).toBe(403);
  expect((await call(url, { Authorization: 'Bearer test-helm-a', Cookie: 'session=anything' })).status).toBe(401);
  expect((await call(url, { Cookie: 'session=anything' })).status).toBe(401);
  expect((await call('https://state.test/v1/accounts/b/dispatches', { Authorization: 'Bearer test-helm-a' })).status).toBe(403);
  expect(await (await call('https://state.test/v1/auth/session', { Authorization: 'Bearer test-helm-a' })).json()).toEqual({ account: 'a', permissions: ['admin'] });
  expect((await call('https://other.test/v1/accounts/a/dispatches', { Authorization: 'Bearer test-helm-a' })).status).toBe(404);
});

it('fences an existing session when its stable GitHub account is no longer invited', async () => {
  await authFixtures();
  const auth = wharfAuth(env); const context = await auth.$context;
  await context.adapter.update({ model: 'account', where: [{ field: 'userId', value: 'a' }], update: { accountId: '999' } });
  expect((await SELF.fetch('https://state.test/v1/accounts/a/dispatches', { headers: { Authorization: 'Bearer test-helm-a' } })).status).toBe(403);
  await context.adapter.update({ model: 'account', where: [{ field: 'userId', value: 'a' }], update: { accountId: '123' } });
});

it('keeps auth routes on the glass host, bounds bodies, strips API cookies and logs out the bearer session', async () => {
  await authFixtures();
  expect((await SELF.fetch('https://state.test/api/auth/sign-in/social', { method: 'POST', body: '{}' })).status).toBe(404);
  expect((await SELF.fetch('https://glass.test/api/auth/update-user', { method: 'POST', body: '{}' })).status).toBe(404);
  for (const route of ['sign-in/magic-link', 'magic-link/verify', 'oauth-proxy/callback', 'device/approve']) {
    expect((await SELF.fetch(`https://glass.test/api/auth/${route}`, { method: 'POST', body: '{}' })).status).toBe(404);
  }
  expect((await SELF.fetch('https://state.test/v1/auth/device/code', { method: 'POST', body: 'x'.repeat(65537) })).status).toBe(413);
  const res = await SELF.fetch('https://state.test/v1/auth/device/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'lobstah-cli', account: 'a', name: 'scripted' }) });
  expect(res.status).toBe(200); expect(res.headers.has('set-cookie')).toBe(false);
  expect((await SELF.fetch('https://state.test/v1/auth/sign-out', { method: 'POST', body: '{}' })).status).toBe(404);
  const logout = await SELF.fetch('https://glass.test/api/auth/sign-out', { method: 'POST', headers: { Authorization: 'Bearer test-helm-a', Origin: 'https://glass.test', 'Content-Type': 'application/json' }, body: '{}' });
  expect(logout.status).toBe(200);
  expect((await SELF.fetch('https://state.test/v1/auth/session', { headers: { Authorization: 'Bearer test-helm-a' } })).status).toBe(401);
});

async function device(name: string, steering = 'read', boatToken?: string) {
  const response = await SELF.fetch('https://state.test/v1/auth/device/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'lobstah-cli', account: 'a', name, steering, ...(boatToken ? { boatToken } : {}) }) });
  expect(response.status).toBe(200);
  return response.json<{ device_code: string; user_code: string }>();
}
const browserHeaders = { Authorization: 'Bearer test-helm-a', Origin: 'https://glass.test', 'Content-Type': 'application/json' };
async function inspect(code: { user_code: string }) {
  return SELF.fetch(`https://glass.test/api/auth/device?user_code=${code.user_code}`, { headers: browserHeaders });
}
async function approve(code: { user_code: string }, name: string, requestedPermissions: string[], permissions: string[], token = 'test-helm-a') {
  return SELF.fetch('https://glass.test/api/auth/wharf/approve', { method: 'POST', headers: { ...browserHeaders, Authorization: `Bearer ${token}` }, body: JSON.stringify({ userCode: code.user_code, name, requestedPermissions, permissions }) });
}
async function redeem(code: { device_code: string }) {
  return SELF.fetch('https://state.test/v1/auth/device/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'lobstah-cli', device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
}
it('binds approval to the displayed request and permits only lower access, issuing a boat credential once', async () => {
  await authFixtures();
  const code = await device('approval-boat', 'helm');
  expect(await (await inspect(code)).json()).toMatchObject({ boatName: 'approval-boat', requestedPermissions: ['work', 'helm'], description: expect.stringContaining('see the grounds state') });
  expect((await approve(code, 'changed-name', ['work', 'helm'], ['work'])).status).toBe(403);
  expect((await approve(code, 'approval-boat', ['work', 'read'], ['work'])).status).toBe(403);
  expect((await approve(code, 'approval-boat', ['work', 'helm'], ['work'], 'test-helm-b')).status).toBe(403);
  expect((await SELF.fetch('https://glass.test/api/auth/device/approve', { method: 'POST', headers: browserHeaders, body: JSON.stringify({ userCode: code.user_code }) })).status).toBe(404);
  expect((await approve(code, 'approval-boat', ['work', 'helm'], ['work', 'admin'])).status).toBe(400);
  expect((await approve(code, 'approval-boat', ['work', 'helm'], ['work'])).status).toBe(200);
  const response = await redeem(code); expect(response.status).toBe(200);
  const result = await response.json<{ token: string; permissions: string[] }>();
  expect(result.permissions).toEqual(['work']); expect(result.token).toMatch(/^b\.a\./);
  expect(JSON.stringify(result)).not.toContain('access_token');
  expect((await redeem(code)).status).toBe(400);
  expect((await SELF.fetch('https://state.test/v1/accounts/a/events', { headers: { Authorization: `Bearer ${result.token}` } })).status).toBe(403);
});
it('work-only enrolment cannot acquire a steering layer, and expired approvals cannot redeem', async () => {
  await authFixtures();
  const code = await device('private-boat', 'none'); await inspect(code);
  expect((await approve(code, 'private-boat', ['work'], ['work', 'read'])).status).toBe(403);
  expect((await approve(code, 'private-boat', ['work'], ['work'])).status).toBe(200);
  await env.AUTH_DB.prepare('UPDATE deviceCode SET expiresAt=? WHERE userCode=?').bind(new Date(0).toISOString(), code.user_code).run();
  expect((await redeem(code)).status).toBe(400);
});
it('re-login rotates only a proven current boat; a fresh enrolment cannot take its name', async () => {
  await authFixtures();
  const first = await device('existing-boat'); expect((await inspect(first)).status).toBe(200);
  expect((await approve(first, 'existing-boat', ['work', 'read'], ['work', 'read'])).status).toBe(200);
  const firstResponse = await redeem(first); expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
  const old = await firstResponse.json<{ id: string; token: string }>();
  const impostor = await device('existing-boat', 'helm'); expect((await inspect(impostor)).status).toBe(200);
  expect((await approve(impostor, 'existing-boat', ['work', 'helm'], ['work', 'helm'])).status).toBe(200);
  expect((await redeem(impostor)).status).toBe(409);
  const again = await device('renamed-boat', 'helm', old.token);
  const shown = await inspect(again); expect(shown.status).toBe(200);
  expect(await shown.json()).toMatchObject({ boatName: 'renamed-boat', previousBoatName: 'existing-boat' });
  expect((await approve(again, 'renamed-boat', ['work', 'helm'], ['work', 'helm'])).status).toBe(200);
  const response = await redeem(again); expect(response.status, await response.clone().text()).toBe(200);
  const next = await response.json<{ id: string; token: string; permissions: string[] }>();
  expect(next.id).toBe(old.id); expect(next.token).not.toBe(old.token); expect(next.permissions).toEqual(['work', 'helm']);
  expect(await (await SELF.fetch('https://state.test/v1/accounts/a/_boat', { headers: { Authorization: `Bearer ${next.token}` } })).json()).toMatchObject({ id: old.id, name: 'renamed-boat' });
  expect((await SELF.fetch('https://state.test/v1/accounts/a/_boat', { headers: { Authorization: `Bearer ${old.token}` } })).status).toBe(401);
});

it('a boat name collision cannot rename another boat during approval', async () => {
  await authFixtures();
  const enroll = async (name: string) => {
    const code = await device(name); expect((await inspect(code)).status).toBe(200);
    expect((await approve(code, name, ['work', 'read'], ['work', 'read'])).status).toBe(200);
    const response = await redeem(code); expect(response.status).toBe(200);
    return response.json<{ id: string; token: string }>();
  };
  const a = await enroll('collision-a'); const b = await enroll('collision-b');
  const code = await device('collision-b', 'read', a.token); expect((await inspect(code)).status).toBe(200);
  expect((await approve(code, 'collision-b', ['work', 'read'], ['work', 'read'])).status).toBe(200);
  expect((await redeem(code)).status).toBe(409);
  for (const boat of [a, b]) expect((await SELF.fetch('https://state.test/v1/accounts/a/_boat', { headers: { Authorization: `Bearer ${boat.token}` } })).status).toBe(200);
});

it('a previously approved re-login cannot overwrite a newer boat credential', async () => {
  await authFixtures();
  const first = await device('fenced-boat'); await inspect(first);
  expect((await approve(first, 'fenced-boat', ['work', 'read'], ['work', 'read'])).status).toBe(200);
  const old = await (await redeem(first)).json<{ id: string; token: string }>();
  const one = await device('fenced-one', 'read', old.token), two = await device('fenced-two', 'read', old.token);
  for (const [code, name] of [[one, 'fenced-one'], [two, 'fenced-two']] as const) {
    await inspect(code); expect((await approve(code, name, ['work', 'read'], ['work', 'read'])).status).toBe(200);
  }
  const current = await (await redeem(one)).json<{ id: string; token: string }>();
  expect(current.id).toBe(old.id); expect((await redeem(two)).status).toBe(409);
  expect(await (await SELF.fetch('https://state.test/v1/accounts/a/_boat', { headers: { Authorization: `Bearer ${current.token}` } })).json()).toMatchObject({ id: old.id, name: 'fenced-one' });
});

it('another invited person cannot inspect, claim or deny an account’s boat approval code', async () => {
  await authFixtures();
  const code = await device('private-to-a');
  expect((await SELF.fetch(`https://glass.test/api/auth/device?user_code=${code.user_code}`, { headers: { ...browserHeaders, Authorization: 'Bearer test-helm-b' } })).status).toBe(403);
  expect(await env.AUTH_DB.prepare('SELECT userId FROM deviceCode WHERE userCode=?').bind(code.user_code).first()).toEqual({ userId: null });
  expect((await SELF.fetch('https://glass.test/api/auth/device/deny', { method: 'POST', headers: { ...browserHeaders, Authorization: 'Bearer test-helm-b' }, body: JSON.stringify({ userCode: code.user_code }) })).status).toBe(403);
  expect((await inspect(code)).status).toBe(200);
});

it('denial and concurrent redemption never issue a person session or two boat credentials', async () => {
  await authFixtures();
  const denied = await device('denied-boat'); expect((await inspect(denied)).status).toBe(200);
  expect((await SELF.fetch('https://glass.test/api/auth/device/deny', { method: 'POST', headers: browserHeaders, body: JSON.stringify({ userCode: denied.user_code }) })).status).toBe(200);
  const refusal = await redeem(denied); expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({ error: 'access_denied' });
  const approved = await device('race-boat'); expect((await inspect(approved)).status).toBe(200);
  expect((await approve(approved, 'race-boat', ['work', 'read'], ['work', 'read'])).status).toBe(200);
  const replies = await Promise.all([redeem(approved), redeem(approved)]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(replies.every((r) => !r.headers.has('set-cookie') && !r.headers.has('set-auth-token'))).toBe(true);
});
