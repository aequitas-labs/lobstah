import { Account } from './account.js';
import { ApiError, boundedBody, digest, identifier, object, sameHash } from './protocol.js';
import type { Command } from './account.js';
export { Account };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url); const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] !== 'v1' || segments[1] !== 'accounts' || !segments[2]) throw new ApiError(404, 'route not found');
      const account = identifier(segments[2]);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (!token || token.length > 1024) throw new ApiError(401, 'credential required');
      // Operator provisions only PAT hashes. A path never chooses authority.
      const configured = object(JSON.parse(env.HELM_PAT_HASHES || '{}'));
      const hashes = configured[account]; const givenHash = await digest(token);
      if (!Array.isArray(hashes) || hashes.length === 0) throw new ApiError(403, 'account not provisioned');
      const helm = Array.isArray(hashes) && hashes.some((h: unknown) => typeof h === 'string' && sameHash(h, givenHash));
      if (!helm && !token.startsWith(`b.${account}.`) && !token.startsWith(`d.${account}.`)) throw new ApiError(403, 'wrong account or credential');
      let body: unknown = {};
      const route = segments.slice(3).join('/');
      const upload = /^dispatches\/[A-Za-z0-9_-]+\/files$/.test(route) && request.method === 'POST';
      if (request.method !== 'GET' && !upload) {
        const bytes = await boundedBody(request);
        try { body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}; } catch { throw new ApiError(400, 'invalid JSON'); }
      }
      const c: Command = { account, helm, token, method: request.method, path: route, body,
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
      if (/^dispatches\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(route) && request.method === 'GET' && result.status === 200) {
        const file = object(result.value); const stored = await env.FILES.get(`${account}/${identifier(file.id)}`);
        if (!stored) throw new ApiError(404, 'file not found');
        return new Response(stored.body, { headers: { 'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox" } });
      }
      return Response.json(result.value, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      // The DO serialises protocol errors, not exception prototypes.
      return Response.json({ error: 'wharf unavailable' }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
