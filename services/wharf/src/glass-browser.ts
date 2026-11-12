import { personSession, authOrigins } from './auth.js';
import { accountResponse } from './account-response.js';
import { ApiError, boundedBody, object, requireThat } from './protocol.js';
import type { Command } from './account.js';
import { glassPage } from './glass-page.js';
import type { SessionHint } from './glass-page.js';
import { glassInstall } from './glass-install.js';
import { completeConnect, connectError, connectUrl, disconnect, personLink, slackConfigured } from './slack-install.js';
import type { SlackEnv } from './slack-install.js';
import { groundStatements, slackGrounds } from './slack-grounds.js';

/**
 * A report's own page, `/report/<key>`, with the key percent-encoded as the
 * glass links it (`report:work:<id>` arrives as `report%3Awork%3A<id>`): the
 * key characters the mirror relays a report's reads for, and no way out of
 * the one segment.
 */
function reportPage(pathname: string): boolean {
  return /^\/report\/[A-Za-z0-9%._-]{1,300}$/.test(pathname) && !pathname.includes('..') && !/%2e%2e|%2f|%5c/i.test(pathname);
}

/** Browser-only routes. No account selector, credential issuance or helm seat. */
export async function glassBrowser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const install = request.method === 'GET' ? glassInstall(url.pathname) : undefined;
  if (install) return install;
  // The glass, boat approval, and a report's own page (the shared glass opens reports there).
  if (request.method === 'GET' && (['/', '/device', '/passkey'].includes(url.pathname) || reportPage(url.pathname))) {
    return glassPage(await sessionHint(env, request));
  }
  const slackReturn = url.pathname === '/api/slack/oauth' && request.method === 'GET';
  requireThat(url.pathname.startsWith('/api/glass') || slackReturn, 404, 'route not found');
  requireThat(!request.headers.has('Authorization'), 401, 'browser routes accept the glass cookie only');
  const headers = new Headers({ Cookie: request.headers.get('Cookie') ?? '' });
  const person = await personSession(env, headers);
  if (slackReturn) return slackConnected(env, url, person);
  const route = url.pathname === '/api/glass' ? 'glass' : url.pathname.slice('/api/glass/'.length);
  if (route === 'slack' || route.startsWith('slack/')) return slackRoute(request, env, route, person);
  // A relayed call's answer comes on the tab's socket, or with the relay itself: there is no call to poll.
  if (request.method === 'GET' && /^mirror\/calls\/[A-Za-z0-9_-]+$/.test(route)) return Response.json({ error: 'a relayed call answers on the socket or with its relay; it is not polled' }, { status: 410 });
  const read = request.method === 'GET' && (['glass', 'dispatches', 'events', 'wake', 'mirror', 'mirror/read', 'cards'].includes(route)
    || /^cards\/c\d{1,15}$/.test(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/detail$/.test(route)
    || /^(documents|dispatches)\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(route));
  const input = request.method === 'POST' && (route === 'requests'
    || /^documents\/[A-Za-z0-9_-]+\/(answer|ack)$/.test(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/ack$/.test(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/cancel$/.test(route)
    || /^boats\/[A-Za-z0-9_-]+\/revoke$/.test(route)
    || route === 'mirror/calls' || route === 'mirror/relay');
  // A file the person attaches to a relayed answer: raw bytes, stored for the boat to fetch.
  const mirrorFile = request.method === 'POST' && route === 'mirror/files';
  const deleting = request.method === 'DELETE' && route === 'account';
  requireThat(read || input || deleting || mirrorFile, 404, 'browser action not available');
  let body: unknown = {};
  if (mirrorFile) requireThat(request.headers.get('Origin') === authOrigins(env).glass, 403, 'same-origin browser action required');
  else if (!read) {
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
    return json({ configured: slackConfigured(env), grounds: await env.ACCOUNTS.getByName(person.id).slackGrounds(), ...(link ? { link: { team: link.team, slackUser: link.slackUser, linkedAt: link.linkedAt, grounds: link.grounds } } : {}) });
  }
  requireThat(request.method === 'POST' && ['slack/connect', 'slack/disconnect', 'slack/grounds'].includes(route), 404, 'browser action not available');
  const { glass } = authOrigins(env);
  requireThat(request.headers.get('Origin') === glass, 403, 'same-origin browser action required');
  if (route === 'slack/connect' || route === 'slack/grounds') {
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(new TextDecoder().decode(await boundedBody(request)))); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Choose the grounds to use with Slack'); }
    const grounds = slackGrounds(body.grounds);
    const available = await env.ACCOUNTS.getByName(person.id).slackGrounds();
    requireThat(grounds.every((name) => available.includes(name)), 400, 'Choose grounds shown in the glass');
    if (route === 'slack/connect') return json({ url: await connectUrl(env, glass, person.id, person.sessionId, grounds) });
    const link = await personLink(env, person.id);
    requireThat(link, 409, 'Connect Slack before choosing its grounds');
    await env.AUTH_DB.batch(groundStatements(env, person.id, grounds));
    await env.ACCOUNTS.getByName(person.id).linkSlack(person.id, { ...link, grounds });
    return json({});
  }
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

/** The visitor's session from its cookie, before the page renders; undefined when the check fails. */
async function sessionHint(env: Env, request: Request): Promise<SessionHint | undefined> {
  if (!request.headers.get('Cookie')) return 'out';
  try {
    await personSession(env, new Headers({ Cookie: request.headers.get('Cookie') ?? '' }));
    return 'in';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return e.status === 403 ? 'denied' : 'out';
    return undefined;
  }
}
