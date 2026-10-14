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
      if (request.method !== 'GET') {
        const bytes = await boundedBody(request);
        try { body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}; } catch { throw new ApiError(400, 'invalid JSON'); }
      }
      const c: Command = { account, helm, token, method: request.method, path: segments.slice(3).join('/'), body,
        key: request.headers.get('Idempotency-Key') ?? undefined, session: request.headers.get('X-Lobstah-Helm') ?? undefined,
        after: url.searchParams.get('after') ?? undefined };
      const stub = env.ACCOUNTS.getByName(account);
      const result = object(JSON.parse(await stub.handle(JSON.stringify(c))));
      if (typeof result.status !== 'number') throw new ApiError(503, 'invalid state response');
      return Response.json(result.value, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      // The DO serialises protocol errors, not exception prototypes.
      return Response.json({ error: 'wharf unavailable' }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
