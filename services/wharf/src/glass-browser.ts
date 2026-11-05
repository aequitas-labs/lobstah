import { personSession, authOrigins } from './auth.js';
import { accountResponse } from './account-response.js';
import { ApiError, boundedBody, object, requireThat } from './protocol.js';
import type { Command } from './account.js';
import { glassPage } from './glass-page.js';
import { glassInstall } from './glass-install.js';

/** Browser-only routes. No account selector, credential issuance or helm seat. */
export async function glassBrowser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const install = request.method === 'GET' ? glassInstall(url.pathname) : undefined;
  if (install) return install;
  if (request.method === 'GET' && ['/', '/device'].includes(url.pathname)) {
    return glassPage();
  }
  requireThat(url.pathname.startsWith('/api/glass'), 404, 'route not found');
  requireThat(!request.headers.has('Authorization'), 401, 'browser routes accept the glass cookie only');
  const headers = new Headers({ Cookie: request.headers.get('Cookie') ?? '' });
  const person = await personSession(env, headers);
  const route = url.pathname === '/api/glass' ? 'glass' : url.pathname.slice('/api/glass/'.length);
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
