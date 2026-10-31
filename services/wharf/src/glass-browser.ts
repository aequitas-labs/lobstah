import { personSession, authOrigins } from './auth.js';
import { accountResponse } from './account-response.js';
import { ApiError, boundedBody, object, requireThat } from './protocol.js';
import type { Command } from './account.js';
import { glassPage } from './glass-page.js';
import { glassInstall } from './glass-install.js';
import { completeConnect, connectError, connectUrl, disconnect, personLink, slackConfigured } from './slack-install.js';
import type { SlackEnv } from './slack-install.js';

/** Browser-only routes. No account selector, credential issuance or helm seat. */
export async function glassBrowser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const install = request.method === 'GET' ? glassInstall(url.pathname) : undefined;
  if (install) return install;
  if (request.method === 'GET' && ['/', '/device'].includes(url.pathname)) {
    return glassPage();
  }
  const slackReturn = url.pathname === '/api/slack/oauth' && request.method === 'GET';
  requireThat(url.pathname.startsWith('/api/glass') || slackReturn, 404, 'route not found');
  requireThat(!request.headers.has('Authorization'), 401, 'browser routes accept the glass cookie only');
  const headers = new Headers({ Cookie: request.headers.get('Cookie') ?? '' });
  const person = await personSession(env, headers);
  if (slackReturn) return slackConnected(env, url, person);
  const route = url.pathname === '/api/glass' ? 'glass' : url.pathname.slice('/api/glass/'.length);
  if (route === 'slack' || route.startsWith('slack/')) return slackRoute(request, env, route, person);
  const read = request.method === 'GET' && (['glass', 'dispatches', 'events', 'wake', 'cards'].includes(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/detail$/.test(route) || /^cards\/c\d{1,15}$/.test(route)
    || /^(documents|dispatches)\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(route));
  const input = request.method === 'POST' && (route === 'requests'
    || /^documents\/[A-Za-z0-9_-]+\/(answer|ack)$/.test(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/ack$/.test(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/cancel$/.test(route)
    || /^boats\/[A-Za-z0-9_-]+\/revoke$/.test(route));
  const deleting = request.method === 'DELETE' && route === 'account';
  requireThat(read || input || deleting, 404, 'browser action not available');
  let body: unknown = {};
  if (!read) {
    requireThat(request.headers.get('Origin') === authOrigins(env).glass, 403, 'same-origin browser action required');
    try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request))); }
    catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(400, 'invalid JSON'); }
    if (deleting) requireThat(object(body).confirm === true, 400, 'confirm account deletion on the boat list');
  }
  const c: Command = { account: person.id, helm: true, personId: person.id, personSessionId: person.sessionId, token: `browser:${person.sessionId}`,
    path: deleting ? '' : route, method: request.method, body, key: request.headers.get('Idempotency-Key') ?? undefined,
    after: url.searchParams.get('after') ?? undefined };
  return accountResponse(request, env, c);
}

type Person = { id: string; sessionId: string };
/** The person's Slack link: see it, start connecting, or disconnect. Writes are same-origin only. */
async function slackRoute(request: Request, env: SlackEnv, route: string, person: Person): Promise<Response> {
  const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  if (route === 'slack' && request.method === 'GET') {
    const link = await personLink(env, person.id);
    return json({ configured: slackConfigured(env), ...(link ? { link: { team: link.team, slackUser: link.slackUser, linkedAt: link.linkedAt } } : {}) });
  }
  requireThat(request.method === 'POST' && ['slack/connect', 'slack/disconnect'].includes(route), 404, 'browser action not available');
  const { glass } = authOrigins(env);
  requireThat(request.headers.get('Origin') === glass, 403, 'same-origin browser action required');
  if (route === 'slack/connect') return json({ url: await connectUrl(env, glass, person.id, person.sessionId) });
  await disconnect(env, person.id);
  await env.ACCOUNTS.getByName(person.id).linkSlack(person.id, null);
  return json({});
}
/** Slack sends the person back here. Linked or not, they land on the boat list, with any reason. */
async function slackConnected(env: SlackEnv, url: URL, person: Person): Promise<Response> {
  const { glass } = authOrigins(env);
  const back = new URL('/', glass);
  try {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    requireThat(!url.searchParams.get('error'), 400, `Slack: ${url.searchParams.get('error')}`);
    requireThat(code && state && code.length <= 512 && state.length <= 128, 400, 'Slack sent back an incomplete connection');
    const link = await completeConnect(env, glass, person.id, person.sessionId, code, state);
    await env.ACCOUNTS.getByName(person.id).linkSlack(person.id, link);
  } catch (e) {
    back.searchParams.set('slack_error', connectError(e));
  }
  back.hash = 'boats';
  return new Response(null, { status: 302, headers: { Location: back.href, 'Cache-Control': 'no-store' } });
}
