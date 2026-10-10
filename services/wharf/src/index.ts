import { Account } from './account.js';
import { ApiError, boundedBody, identifier, object } from './protocol.js';
import { authOrigins, authRequest, deletePersonData, deletionReceipt, personSession } from './auth.js';
import type { Command } from './account.js';
export { Account };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let cors: string | undefined;
    const respond = (response: Response) => {
      if (!cors) return response;
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', cors); headers.set('Vary', 'Origin');
      return new Response(response.body, { status: response.status, headers });
    };
    try {
      const url = new URL(request.url); const segments = url.pathname.split('/').filter(Boolean);
      const origins = authOrigins(env); const origin = request.headers.get('Origin');
      if (origin && origin !== origins.glass) throw new ApiError(403, 'foreign browser origin');
      const api = url.origin === origins.api;
      if (api && request.headers.has('Cookie')) throw new ApiError(401, 'the API accepts bearer tokens, not cookies');
      if (!api && url.origin !== origins.glass) throw new ApiError(404, 'unknown wharf host');
      if (api && origin) cors = origins.glass;
      if (api && request.method === 'OPTIONS') return respond(new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Lobstah-Helm, X-File-Name',
      } }));
      if (url.pathname.startsWith(api ? '/v1/auth/' : '/api/auth/')) {
        if (api && url.pathname === '/v1/auth/session') return respond(Response.json({ account: (await personSession(env, new Headers({ Authorization: request.headers.get('Authorization') ?? '' }))).id, permissions: ['admin'] }, { headers: { 'Cache-Control': 'no-store' } }));
        if (request.method !== 'GET') request = new Request(request, { body: await boundedBody(request) });
        return respond(await authRequest(request, env, api));
      }
      if (!api) throw new ApiError(404, 'route not found');
      if (segments[0] !== 'v1' || segments[1] !== 'accounts' || !segments[2]) throw new ApiError(404, 'route not found');
      const account = identifier(segments[2]);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (!token || token.length > 1024) throw new ApiError(401, 'credential required');
      // OAuth's random user ID owns exactly one account, never the requested path.
      const scoped = token.startsWith('b.') || token.startsWith('d.');
      const deleting = segments.length === 3 && request.method === 'DELETE';
      const receipt = !scoped && deleting && await deletionReceipt(env, account, token, request.headers.get('Idempotency-Key'));
      const person = scoped ? undefined : receipt ? { id: account } : await personSession(env, new Headers({ Authorization: `Bearer ${token}` }));
      if (person ? person.id !== account : !token.startsWith(`b.${account}.`) && !token.startsWith(`d.${account}.`)) throw new ApiError(403, 'wrong account or credential');
      const helm = !!person;
      let body: unknown = {};
      const route = segments.slice(3).join('/');
      if (route === 'boats' && request.method === 'POST') throw new ApiError(404, 'boats enroll through approved login only');
      const upload = /^(dispatches|documents)\/[A-Za-z0-9_-]+\/files$/.test(route) && request.method === 'POST';
      if (request.method !== 'GET' && !upload) {
        const bytes = await boundedBody(request);
        try { body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}; } catch { throw new ApiError(400, 'invalid JSON'); }
      }
      const c: Command = { account, helm, personId: person?.id, token, method: request.method, path: route, body,
        key: request.headers.get('Idempotency-Key') ?? undefined, session: request.headers.get('X-Lobstah-Helm') ?? undefined,
        after: url.searchParams.get('after') ?? undefined };
      const stub = env.ACCOUNTS.getByName(account);
      let serialized: string;
      if (upload) {
        c.body = { name: request.headers.get('X-File-Name') ?? 'attachment' };
        serialized = await stub.upload(JSON.stringify(c), await boundedBody(request, Number(env.MAX_FILE_BYTES)));
      } else if (!route && request.method === 'DELETE') serialized = await stub.deleteAccount(JSON.stringify(c));
      else serialized = await stub.handle(JSON.stringify(c));
      const result = object(JSON.parse(serialized));
      if (typeof result.status !== 'number') throw new ApiError(503, 'invalid state response');
      if (deleting && result.status === 200) await deletePersonData(env, account, token, c.key!);
      if (/^(dispatches|documents)\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(route) && request.method === 'GET' && result.status === 200) {
        const file = object(result.value); const stored = await env.FILES.get(`${account}/${identifier(file.id)}`);
        if (!stored) throw new ApiError(404, 'file not found');
        return respond(new Response(stored.body, { headers: { 'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox" } }));
      }
      return respond(Response.json(result.value, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }));
    } catch (e) {
      if (e instanceof ApiError) return respond(Response.json({ error: e.message }, { status: e.status }));
      // The DO serialises protocol errors, not exception prototypes.
      return respond(Response.json({ error: 'wharf unavailable' }, { status: 503 }));
    }
  },
} satisfies ExportedHandler<Env>;
