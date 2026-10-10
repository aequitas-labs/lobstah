import { personSession, authOrigins } from './auth.js';
import { accountResponse } from './account-response.js';
import { ApiError, boundedBody, object, requireThat } from './protocol.js';
import type { Command } from './account.js';
import { GLASS_CSS, GLASS_SCRIPT } from './glass-page.generated.js';

/** Browser-only routes. No account selector, credential issuance or helm seat. */
export async function glassBrowser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && ['/', '/device'].includes(url.pathname)) {
    const nonce = crypto.randomUUID();
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>lobstah spyglass</title><style nonce="${nonce}">${GLASS_CSS}</style></head><body><script nonce="${nonce}">${GLASS_SCRIPT}</script></body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` },
    });
  }
  requireThat(url.pathname.startsWith('/api/glass'), 404, 'route not found');
  requireThat(!request.headers.has('Authorization'), 401, 'browser routes accept the glass cookie only');
  const headers = new Headers({ Cookie: request.headers.get('Cookie') ?? '' });
  const person = await personSession(env, headers);
  const route = url.pathname === '/api/glass' ? 'glass' : url.pathname.slice('/api/glass/'.length);
  const read = request.method === 'GET' && (['glass', 'dispatches', 'events', 'wake'].includes(route)
    || /^dispatches\/[A-Za-z0-9_-]+\/detail$/.test(route)
    || /^(documents|dispatches)\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(route));
  const input = request.method === 'POST' && (route === 'requests'
    || /^documents\/[A-Za-z0-9_-]+\/answer$/.test(route)
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
