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
    // Never forward a caller-supplied internal header or a bearer in the URL. The subprotocol says which socket protocol the client speaks.
    return stub.fetch('https://internal/wake', { headers: { Upgrade: request.headers.get('Upgrade') ?? '', 'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol') ?? '', 'X-Wharf-Command': JSON.stringify(c) } });
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
  // The hosted glass's relay: post one call and wait for its boat's answer, so a read is one request (an image's src too).
  if (c.path === 'mirror/read' && c.method === 'GET') {
    const query = new URL(request.url).searchParams;
    return relayAndWait(request, env, c, { id: crypto.randomUUID(), boat: query.get('boat') ?? '', read: query.get('path') ?? '' });
  }
  if (c.path === 'mirror/relay' && c.method === 'POST') return relayAndWait(request, env, c, c.body);
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
  // Another boat's lists: one the reader holds at the same ETag comes back unchanged, without its items.
  if (c.path === 'mirror/attention' && c.method === 'GET') {
    const known = new Map((new URL(request.url).searchParams.get('known') ?? '').split(',').filter(Boolean).map((pair) => pair.split(':') as [string, string]));
    const boats = (object(result.value).boats as Array<{ boat: string; etag: string; attention?: unknown[] }>)
      .map(({ attention, ...b }) => (known.get(b.boat) === b.etag ? { ...b, unchanged: true } : { ...b, attention }));
    return Response.json({ boats }, { headers: noStore });
  }
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

/** How long the relay waits for a boat before it answers 202 and leaves the page to poll the call. */
const MIRROR_RELAY_WAIT_MS = 20_000;
/**
 * How often it looks: soon at first, then less often, up to every 2 s. Each
 * look counts against the account's mirror budget, so a slow boat costs a
 * dozen looks over the 20 s, not 50.
 */
const MIRROR_RELAY_POLL_MS = 400;
const MIRROR_RELAY_POLL_MAX_MS = 2_000;

/**
 * Post one call and wait for its boat's answer, then answer with it: the
 * boat's status, type and body. A boat that has not answered in time gives
 * 202 with the call's id, which the page polls. Posting the same id again
 * waits for that call, so a page's retry never runs a write twice.
 */
async function relayAndWait(request: Request, env: Env, c: Command, call: unknown): Promise<Response> {
  const stub = env.ACCOUNTS.getByName(c.account);
  const created = object(JSON.parse(await stub.mirror(JSON.stringify({ ...c, method: 'POST', path: 'mirror/calls', body: call }))));
  const id = typeof (call as { id?: unknown })?.id === 'string' ? (call as { id: string }).id : '';
  if (created.status !== 200 && !(created.status === 409 && id)) return Response.json(created.value, { status: Number(created.status), headers: noStore });
  const deadline = Date.now() + MIRROR_RELAY_WAIT_MS;
  for (let wait = MIRROR_RELAY_POLL_MS; ; wait = Math.min(wait * 1.5, MIRROR_RELAY_POLL_MAX_MS)) {
    const answer = await mirrorResponse(request, env, { ...c, method: 'GET', path: `mirror/calls/${id}`, body: {} });
    if (answer.status !== 202 || Date.now() >= deadline) return answer;
    await answer.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, Math.max(0, deadline - Date.now()))));
  }
}
