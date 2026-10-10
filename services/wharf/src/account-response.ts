import { deletePersonData } from './auth.js';
import type { Command } from './account.js';
import { ApiError, boundedBody, identifier, object } from './protocol.js';

/** Both HTTP hosts share scoped file/download and account-deletion behavior. */
export async function accountResponse(request: Request, env: Env, c: Command): Promise<Response> {
  const stub = env.ACCOUNTS.getByName(c.account);
  if (c.path === 'wake' && c.method === 'GET') {
    // Never forward a caller-supplied internal header or a bearer in the URL.
    return stub.fetch('https://internal/wake', { headers: { Upgrade: request.headers.get('Upgrade') ?? '', 'X-Wharf-Command': JSON.stringify(c) } });
  }
  const upload = /^(dispatches|documents)\/[A-Za-z0-9_-]+\/files$/.test(c.path) && c.method === 'POST';
  const deleting = !c.path && c.method === 'DELETE';
  let serialized: string;
  if (upload) {
    c.body = { name: request.headers.get('X-File-Name') ?? 'attachment' };
    serialized = await stub.upload(JSON.stringify(c), await boundedBody(request, Number(env.MAX_FILE_BYTES)));
  } else if (deleting) serialized = await stub.deleteAccount(JSON.stringify(c));
  else serialized = await stub.handle(JSON.stringify(c));
  const result = object(JSON.parse(serialized));
  if (typeof result.status !== 'number') throw new ApiError(503, 'invalid state response');
  if (deleting && result.status === 200) await deletePersonData(env, c.account, c.token, c.key!);
  if (/^(dispatches|documents)\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(c.path) && c.method === 'GET' && result.status === 200) {
    const file = object(result.value); const stored = await env.FILES.get(`${c.account}/${identifier(file.id)}`);
    if (!stored) throw new ApiError(404, 'file not found');
    return new Response(stored.body, { headers: { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  return Response.json(result.value, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
