import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { boatDevice } from './device.js';
import { ApiError, digest, identifier, requireThat } from './protocol.js';

/** All host and browser-origin checks use this same deployment configuration. */
export function authOrigins(env: Env): { glass: string; api: string } {
  const origin = (value: string) => {
    let u: URL; try { u = new URL(value); } catch { throw new ApiError(503, 'wharf origins are not configured'); }
    requireThat(u.origin === value && !u.username && !u.password && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)), 503, 'invalid wharf origin');
    return u.origin;
  };
  const glass = origin(env.GLASS_ORIGIN), api = origin(env.API_ORIGIN);
  requireThat(glass !== api, 503, 'glass and API must use distinct origins');
  return { glass, api };
}
function invited(env: Env, githubId: unknown): boolean {
  if (typeof githubId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(githubId)) return false;
  const ids: unknown = JSON.parse(env.GITHUB_ALLOWLIST);
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) && ids.includes(githubId);
}
export function wharfAuth(env: Env) {
  const { glass } = authOrigins(env);
  return betterAuth({
    database: env.AUTH_DB, baseURL: glass, secret: env.AUTH_SECRET,
    trustedOrigins: [glass],
    socialProviders: { github: {
      clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    } },
    user: {
      validateUserInfo: ({ source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'github' || !invited(env, String(source.oauth.profile?.id))) return { error: 'invite_required', errorDescription: 'This wharf is invite-only. Ask its operator for an invitation.' };
      },
    },
    account: { storeStateStrategy: 'database', encryptOAuthTokens: true, accountLinking: { enabled: false } },
    session: { cookieCache: { enabled: false } },
    advanced: { crossSubDomainCookies: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    plugins: [bearer(), ...boatDevice(env, glass)],
    logger: { disabled: true },
  });
}
/** The HTTP boundary supplies bearer headers only on the API host. */
export async function personSession(env: Env, headers: Headers): Promise<{ id: string; sessionId: string }> {
  const session = await wharfAuth(env).api.getSession({ headers });
  if (!session) throw new ApiError(401, 'sign in to the glass with GitHub');
  const provider = await env.AUTH_DB.prepare('SELECT accountId FROM account WHERE userId=? AND providerId=?').bind(session.user.id, 'github').first<{ accountId: string }>();
  requireThat(invited(env, provider?.accountId), 403, 'This wharf is invite-only. Ask its operator for an invitation.');
  return { id: identifier(session.user.id), sessionId: session.session.id };
}

/** Wake hints never retain cookie/token secrets, and recheck the session by ID. */
export async function personSessionLive(env: Env, id: string, sessionId: string): Promise<boolean> {
  const context = await wharfAuth(env).$context;
  const session = await context.adapter.findOne<{ expiresAt: Date }>({ model: 'session', where: [{ field: 'id', value: sessionId }, { field: 'userId', value: id }] });
  const provider = await env.AUTH_DB.prepare('SELECT accountId FROM account WHERE userId=? AND providerId=?').bind(id, 'github').first<{ accountId: string }>();
  return !!session && new Date(session.expiresAt).getTime() > Date.now() && invited(env, provider?.accountId);
}

/** A receipt authorizes only the same deletion retry, never any normal request. */
export async function deletionReceipt(env: Env, account: string, token: string, key: string | null): Promise<boolean> {
  if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) return false;
  const row = await env.AUTH_DB.prepare('SELECT account FROM deletionReceipt WHERE account=? AND credentialHash=? AND keyHash=?').bind(account, await digest(token), await digest(key)).first();
  return !!row;
}
export async function deletePersonData(env: Env, account: string, token: string, key: string): Promise<void> {
  // D1 batch is atomic; no session remains usable if its identity row is removed.
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('INSERT OR REPLACE INTO deletionReceipt VALUES (?,?,?)').bind(account, await digest(token), await digest(key)),
    env.AUTH_DB.prepare('DELETE FROM session WHERE userId=?').bind(account),
    env.AUTH_DB.prepare('DELETE FROM account WHERE userId=?').bind(account),
    env.AUTH_DB.prepare("DELETE FROM deviceCode WHERE userId=? OR json_extract(requestData,'$.account')=?").bind(account, account),
    env.AUTH_DB.prepare('DELETE FROM user WHERE id=?').bind(account),
  ]);
}

/** Do not expose unrelated Better Auth account mutation endpoints. */
const browserRoutes = new Set(['sign-in/social', 'callback/github', 'get-session', 'sign-out', 'device', 'wharf/approve', 'device/deny', 'error']);
const tokenRoutes = new Set(['device/code', 'device/token']);
export async function authRequest(request: Request, env: Env, api: boolean): Promise<Response> {
  const { glass } = authOrigins(env); const url = new URL(request.url);
  const route = url.pathname.slice(api ? '/v1/auth/'.length : '/api/auth/'.length);
  requireThat((api ? tokenRoutes : browserRoutes).has(route), 404, 'auth route not found');
  if (!api && ['device', 'wharf/approve', 'device/deny'].includes(route)) {
    const person = await personSession(env, request.headers);
    if (route === 'device' || route === 'device/deny') {
      const userCode = request.method === 'GET' ? url.searchParams.get('user_code') : (await request.clone().json() as { userCode?: unknown }).userCode;
      requireThat(typeof userCode === 'string' && userCode.length <= 128, 400, 'invalid device code');
      const code = await env.AUTH_DB.prepare('SELECT id,status,requestData FROM deviceCode WHERE userCode=?').bind(userCode).first<{ id: string; status: string; requestData: string }>();
      requireThat(code && JSON.parse(code.requestData).account === person.id, 403, 'boat approval belongs to another account or is invalid');
      if (route === 'device' && request.method === 'GET' && code.status === 'pending') {
        const data = JSON.parse(code.requestData);
        if (!data.nameResolved) {
          data.name = await env.ACCOUNTS.getByName(person.id).availableBoatName(data.name, data.id);
          data.nameResolved = true;
          // Resolve before rendering, never silently rename an already approved boat.
          await env.AUTH_DB.prepare("UPDATE deviceCode SET requestData=? WHERE id=? AND status='pending' AND requestData=?")
            .bind(JSON.stringify(data), code.id, code.requestData).run();
        }
      }
    }
  }
  const headers = new Headers(request.headers);
  if (api) { headers.delete('cookie'); headers.delete('origin'); }
  const target = new URL(`/api/auth/${api && route === 'device/token' ? 'wharf/token' : route}${url.search}`, glass);
  const response = await wharfAuth(env).handler(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  if (!api) return response;
  const safe = new Headers(response.headers); safe.delete('set-cookie'); safe.delete('set-auth-token');
  return new Response(response.body, { status: response.status, headers: safe });
}
