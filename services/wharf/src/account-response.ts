import { deletePersonData } from './auth.js';
import type { Command } from './account.js';
import { ApiError, boundedBody, identifier, object } from './protocol.js';
import { MIRROR_SNAPSHOT_MAX_BYTES } from '../../../packages/core/src/backend-model.js';
import type { WharfMirrorCall } from '../../../packages/core/src/backend-model.js';
import { mirrorAnswerKey } from './mirror-state.js';
import type { MirrorListing } from './mirror-state.js';

/** Both HTTP hosts share scoped file/download and account-deletion behavior. */
export async function accountResponse(request: Request, env: Env, c: Command): Promise<Response> {
  const stub = env.ACCOUNTS.getByName(c.account);
  if (c.path === 'wake' && c.method === 'GET') {
    // Never forward a caller-supplied internal header or a bearer in the URL.
    return stub.fetch('https://internal/wake', { headers: { Upgrade: request.headers.get('Upgrade') ?? '', 'X-Wharf-Command': JSON.stringify(c) } });
  }
  if (c.path === 'mirror' || c.path.startsWith('mirror/')) return mirrorResponse(request, env, c);
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

const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Whether a mirror route carries raw bytes, not JSON: a snapshot put, a call's answer, or an uploaded file. */
export function mirrorRawBody(path: string, method: string): boolean {
  return path === 'mirror/snapshot' && method === 'PUT' || /^mirror\/calls\/[A-Za-z0-9_-]+\/answer$/.test(path) && method === 'POST'
    || path === 'mirror/files' && method === 'POST';
}

/**
 * The mirror routes. The account object authorizes each and keeps their
 * state; this side moves the bytes. The hosted glass's list unpacks each
 * boat's snapshot the page does not already hold (`?known=<boat>:<etag>,…`);
 * a call's answer comes back as the boat's own response, status and type.
 */
async function mirrorResponse(request: Request, env: Env, c: Command): Promise<Response> {
  const stub = env.ACCOUNTS.getByName(c.account);
  let serialized: string;
  if (mirrorRawBody(c.path, c.method)) {
    const max = c.path === 'mirror/snapshot' ? MIRROR_SNAPSHOT_MAX_BYTES : Number(env.MAX_FILE_BYTES);
    const bytes = await boundedBody(request, max);
    const meta = {
      ...(request.headers.has('X-Mirror-Status') ? { status: Number(request.headers.get('X-Mirror-Status')) } : {}),
      ...(request.headers.has('Content-Type') ? { contentType: request.headers.get('Content-Type')! } : {}),
      ...(request.headers.has('X-File-Name') ? { name: request.headers.get('X-File-Name')! } : {}),
      ...(request.headers.has('X-Mirror-Boat') ? { boat: request.headers.get('X-Mirror-Boat')! } : {}),
    };
    serialized = await stub.mirror(JSON.stringify(c), bytes, meta);
  } else serialized = await stub.mirror(JSON.stringify(c));
  const result = object(JSON.parse(serialized));
  if (typeof result.status !== 'number') throw new ApiError(503, 'invalid state response');
  if (result.status !== 200) return Response.json(result.value, { status: result.status, headers: noStore });
  if (c.path === 'mirror' && c.method === 'GET') {
    const known = new Map((new URL(request.url).searchParams.get('known') ?? '').split(',').filter(Boolean).map((pair) => pair.split(':') as [string, string]));
    const boats = (object(result.value).boats as MirrorListing[]);
    // Each snapshot is spliced in as the JSON the boat put, never parsed again here.
    const parts = await Promise.all(boats.map(async ({ key, ...boat }) => {
      if (known.get(boat.boat) === boat.etag) return JSON.stringify({ ...boat, unchanged: true });
      const stored = await env.FILES.get(key);
      if (!stored) return JSON.stringify({ ...boat, missing: true });
      const text = await new Response(stored.body.pipeThrough(new DecompressionStream('gzip'))).text();
      return `${JSON.stringify(boat).slice(0, -1)},"snapshot":${text}}`;
    }));
    return new Response(`{"boats":[${parts.join(',')}]}`, { headers: { ...noStore, 'Content-Type': 'application/json' } });
  }
  if (/^mirror\/calls\/[A-Za-z0-9_-]+$/.test(c.path) && c.method === 'GET') {
    const call = result.value as WharfMirrorCall;
    if (call.state === 'expired') return Response.json({ id: call.id, state: call.state, error: 'the boat did not answer in time' }, { status: 410, headers: noStore });
    if (call.state !== 'answered' || !call.answer) return Response.json({ id: call.id, state: call.state }, { status: 202, headers: noStore });
    const stored = await env.FILES.get(mirrorAnswerKey(c.account, call.id));
    if (!stored) return Response.json({ id: call.id, state: 'expired', error: 'the answer is gone' }, { status: 410, headers: noStore });
    // The boat's own answer: its status and type, sandboxed as the boat's glass serves its files.
    return new Response(stored.body, { status: call.answer.status, headers: { ...noStore, 'Content-Type': call.answer.contentType,
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Lobstah-Mirror-Call': 'answered' } });
  }
  if (/^mirror\/files\/[A-Za-z0-9_-]+$/.test(c.path) && c.method === 'GET') {
    const file = object(result.value); const stored = await env.FILES.get(String(file.key));
    if (!stored) return Response.json({ error: 'file not found' }, { status: 404, headers: noStore });
    return new Response(stored.body, { headers: { ...noStore, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
      'X-File-Name': encodeURIComponent(String(file.name)) } });
  }
  return Response.json(result.value, { status: 200, headers: noStore });
}
