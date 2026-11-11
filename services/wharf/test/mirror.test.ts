import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { wharfAuth } from '../src/auth.js';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { mirrorTables } from '../src/mirror-state.js';
import { authFixtures } from './auth-fixture.js';
import type { WharfMirrorCall } from '../../../packages/core/src/backend-model.js';

/**
 * A mirror boat keeps its fleet on its own grounds and shows it on the
 * hosted glass: it puts its glass snapshot, and answers the reads and
 * writes the hosted glass relays to it. The wharf keeps each boat's latest
 * snapshot and calls in transit, addressed to one boat each.
 */

type Boat = { id: string; token: string; name: string };
let cookie: string, account: string, sequence = 0;
const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
/** A signed-in person's request from the hosted glass. */
const browser = (path: string, init: { body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) =>
  SELF.fetch(`https://glass.test/api/glass/${path}`, {
    method: init.body === undefined && init.raw === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: 'https://glass.test', ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}),
  });
/** A boat's request with its own credential. */
const boatCall = (boat: Pick<Boat, 'token'>, path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
  SELF.fetch(`https://state.test/v1/accounts/${account}/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${boat.token}`, 'Idempotency-Key': `boat-${++sequence}`, ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
const sql = (statement: string, ...bindings: SqlStorageValue[]) =>
  runInDurableObject(env.ACCOUNTS.getByName(account), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());

/** Enrol a boat with exactly these permissions. */
async function enrol(name: string, permissions: string[]): Promise<Boat> {
  const result = JSON.parse(await env.ACCOUNTS.getByName(account).handle(JSON.stringify({
    account, helm: true, personId: account, token: 'unused', method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}`,
  })));
  expect(result.status, JSON.stringify(result.value)).toBe(201);
  return { ...(result.value as { id: string; token: string }), name };
}
async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
/** A snapshot as a boat's local glass serves it, without its page token. */
const snapshot = (fleet: string) => ({ generatedAt: '2026-11-09T12:00:00.000Z', traps: [{ trapId: `${fleet}-trap`, name: `${fleet} gull` }], attention: [], decisions: [] });
async function put(boat: Boat, body: unknown): Promise<Response> {
  return boatCall(boat, 'mirror/snapshot', { method: 'PUT', body: await gzip(JSON.stringify(body)), headers: { 'Content-Type': 'application/gzip' } });
}
type Listed = { boat: string; name: string; at: string; etag: string; bytes: number; unchanged?: true; snapshot?: ReturnType<typeof snapshot> };
async function list(known = ''): Promise<Listed[]> {
  const r = await browser(`mirror${known ? `?known=${known}` : ''}`);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json<{ boats: Listed[] }>()).boats;
}
async function relay(boat: Boat, call: Record<string, unknown>): Promise<WharfMirrorCall> {
  const r = await browser('mirror/calls', { body: { id: `call-${++sequence}`, boat: boat.id, ...call } });
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json<WharfMirrorCall>();
}
async function answer(boat: Boat, call: string, status: number, body: string, contentType = 'application/json'): Promise<Response> {
  return boatCall(boat, `mirror/calls/${call}/answer`, { body, headers: { 'X-Mirror-Status': String(status), 'Content-Type': contentType } });
}

beforeAll(async () => {
  await authFixtures();
  const start = await SELF.fetch('https://glass.test/api/auth/sign-in/social', { method: 'POST', headers: { Origin: 'https://glass.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'github', callbackURL: 'https://glass.test/' }) });
  expect(start.status).toBe(200);
  const state = new URL((await start.json<{ url: string }>()).url).searchParams.get('state')!;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'mirror-stub', token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 123, login: 'mirror-test', name: 'Mirror Test', email: 'mirror@example.test', avatar_url: null });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'mirror@example.test', primary: true, verified: true }]);
    throw new Error('unexpected OAuth destination');
  });
  try {
    const callback = await SELF.fetch(`https://glass.test/api/auth/callback/github?code=stub&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { Cookie: cookies(start) } });
    expect(callback.status).toBe(302); cookie = cookies(callback);
    account = (await wharfAuth(env).api.getSession({ headers: new Headers({ Cookie: cookie }) }))!.user.id;
  } finally { outbound.mockRestore(); }
});
beforeEach(async () => {
  await runInDurableObject(env.ACCOUNTS.getByName(account), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'configured_workers', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'claims', 'messages', 'files', ...glassTables, ...mirrorTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
  });
  const stored = await env.FILES.list({ prefix: `${account}/` }); if (stored.objects.length) await env.FILES.delete(stored.objects.map((o) => o.key));
  await env.AUTH_DB.exec('DELETE FROM rateLimit');
});

describe('mirror snapshots', () => {
  it('lists every mirror boat’s latest snapshot, each with its boat and put time', async () => {
    const north = await enrol('north', ['mirror', 'read']), south = await enrol('south', ['mirror', 'read']);
    expect((await put(north, snapshot('north'))).status).toBe(200);
    expect((await put(south, snapshot('south'))).status).toBe(200);
    const boats = await list();
    expect(boats.map((b) => [b.boat, b.name, b.snapshot?.traps[0]?.trapId])).toEqual([[north.id, 'north', 'north-trap'], [south.id, 'south', 'south-trap']]);
    for (const b of boats) {
      expect(Number.isFinite(Date.parse(b.at))).toBe(true);
      expect(b.etag).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('keeps only the latest snapshot, and leaves out the ones the page already holds', async () => {
    const north = await enrol('north', ['mirror', 'read']), south = await enrol('south', ['mirror', 'read']);
    await put(north, snapshot('north'));
    await put(north, { ...snapshot('north'), traps: [] });
    await put(south, snapshot('south'));
    const first = await list();
    expect(first.find((b) => b.boat === north.id)?.snapshot?.traps).toEqual([]);
    expect((await env.FILES.list({ prefix: `${account}/mirror/snapshots/` })).objects).toHaveLength(2);
    const known = first.map((b) => `${b.boat}:${b.etag}`).join(',');
    const again = await list(known);
    expect(again.map((b) => [b.name, b.unchanged, b.snapshot])).toEqual([['north', true, undefined], ['south', true, undefined]]);
  });

  it('refuses a snapshot that carries the page token, or is not gzip', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    expect((await put(north, { ...snapshot('north'), focusToken: 'secret' })).status).toBe(400);
    expect((await boatCall(north, 'mirror/snapshot', { method: 'PUT', body: '{"traps":[]}' })).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  it('drops a revoked boat’s snapshot and calls', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    await put(north, snapshot('north'));
    await relay(north, { read: '/data/stats' });
    const revoked = await browser(`boats/${north.id}/revoke`, { body: {}, headers: { 'Idempotency-Key': `revoke-${++sequence}` } });
    expect(revoked.status).toBe(200);
    expect(await list()).toEqual([]);
    expect(await sql('SELECT count(*) AS n FROM mirror_calls')).toEqual([{ n: 0 }]);
  });
});

describe('relayed calls', () => {
  it('returns the addressed boat’s answer to the person, with status 200', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const call = await relay(north, { read: '/data/stats' });
    expect(call).toMatchObject({ boat: north.id, read: '/data/stats', state: 'queued' });
    const waiting = await browser(`mirror/calls/${call.id}`);
    expect(waiting.status).toBe(202);
    const queued = await (await boatCall(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>();
    expect(queued.calls.map((c) => c.id)).toEqual([call.id]);
    expect((await boatCall(north, `mirror/calls/${call.id}/take`, { body: '{}' })).status).toBe(200);
    expect((await answer(north, call.id, 200, '{"catchesToday":3}')).status).toBe(200);
    const answered = await browser(`mirror/calls/${call.id}`);
    expect(answered.status).toBe(200);
    expect(answered.headers.get('Content-Type')).toBe('application/json');
    expect(await answered.json()).toEqual({ catchesToday: 3 });
  });

  it('relays a write with its request kind and payload, and a refusal with the boat’s status', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const call = await relay(north, { write: { kind: 'decision-answer', payload: { key: 'decision:0a1b2c3d', option: 'One' } } });
    await boatCall(north, `mirror/calls/${call.id}/take`, { body: '{}' });
    await answer(north, call.id, 409, '{"ok":false,"reason":"already answered"}');
    const answered = await browser(`mirror/calls/${call.id}`);
    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({ ok: false, reason: 'already answered' });
  });

  it('relays a sealed line for an interactive run to its boat as the page sent it', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const payload = { key: 'decision:0a1b2c3d', attempt: 'a1', seq: 0, secret: false, sealed: { epk: 'ZXBr', iv: 'aXY', ct: 'Y3Q' }, signature: 'c2ln' };
    const call = await relay(north, { write: { kind: 'run-line', payload } });
    expect(call.write).toEqual({ kind: 'run-line', payload });
    const waiting = await (await boatCall(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>();
    expect(waiting.calls.find((c) => c.id === call.id)?.write).toEqual({ kind: 'run-line', payload });
  });

  it('delivers a call to the boat it names only', async () => {
    const north = await enrol('north', ['mirror', 'read']), south = await enrol('south', ['mirror', 'read']);
    const call = await relay(north, { read: '/data/settings' });
    expect((await (await boatCall(south, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>()).calls).toEqual([]);
    expect((await boatCall(south, `mirror/calls/${call.id}/take`, { body: '{}' })).status).toBe(403);
    await boatCall(north, `mirror/calls/${call.id}/take`, { body: '{}' });
    expect((await answer(south, call.id, 200, '{}')).status).toBe(403);
  });

  it('expires a call not answered in 10 minutes, and its boat never receives it again', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const call = await relay(north, { read: '/data/stats' });
    await sql("UPDATE mirror_calls SET data=json_set(data,'$.expiresAt',?) WHERE id=?", new Date(Date.now() - 1000).toISOString(), call.id);
    const expired = await browser(`mirror/calls/${call.id}`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ state: 'expired' });
    expect((await (await boatCall(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>()).calls).toEqual([]);
    expect((await boatCall(north, `mirror/calls/${call.id}/take`, { body: '{}' })).status).toBe(410);
  });

  it('refuses a read or write the hosted glass may not relay', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    for (const call of [{ read: '/data' }, { read: '/api/focus/trap' }, { read: '/data/dispatch/%2e%2e' }, { write: { kind: 'focus', payload: {} } }]) {
      expect((await browser('mirror/calls', { body: { id: `refused-${++sequence}`, boat: north.id, ...call } })).status).toBe(403);
    }
  });

  it.each(['review-mode', 'helm-chat'])('refuses %s from hosted glass and mirror/read boat credentials', async (kind) => {
    const north = await enrol('north', ['mirror', 'read']);
    const write = { kind, payload: kind === 'review-mode' ? { mode: 'auto-review', publish: true } : { grounds: 'home', chat: 'brief' } };
    for (const path of ['mirror/calls', 'mirror/relay']) {
      const body = { id: `settings-${++sequence}`, boat: north.id, write };
      expect((await browser(path, { body })).status).toBe(403);
      expect((await boatCall(north, path, { body: JSON.stringify(body) })).status).toBe(403);
    }
    expect(await sql('SELECT count(*) AS n FROM mirror_calls')).toEqual([{ n: 0 }]);
    expect((await (await boatCall(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>()).calls).toEqual([]);
  });

  it('carries a file the person attached to a relayed answer to its boat', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const uploaded = await browser('mirror/files', { raw: 'tray sketch', headers: { 'X-File-Name': 'tray.txt', 'X-Mirror-Boat': north.id } });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const file = await uploaded.json<{ id: string; name: string; size: number }>();
    expect(file).toMatchObject({ name: 'tray.txt', size: 11 });
    await relay(north, { write: { kind: 'decision-answer', payload: { key: 'decision:0a1b2c3d', text: 'see sketch' } }, files: [file.id] });
    const fetched = await boatCall(north, `mirror/files/${file.id}`);
    expect(fetched.status).toBe(200);
    expect(decodeURIComponent(fetched.headers.get('X-File-Name')!)).toBe('tray.txt');
    expect(await fetched.text()).toBe('tray sketch');
  });
});

describe('who may mirror', () => {
  it('refuses a work-only boat and a dispatch token on every mirror route', async () => {
    const worker = await enrol('worker', ['work', 'read']);
    expect((await put(worker, snapshot('worker'))).status).toBe(403);
    expect((await boatCall(worker, 'mirror/calls')).status).toBe(403);
    expect((await boatCall(worker, 'mirror')).status).toBe(403);
    const dispatchToken = { token: `d.${account}.job.1.secret` };
    expect((await boatCall(dispatchToken, 'mirror/calls')).status).toBe(403);
    expect((await boatCall(dispatchToken, 'mirror/snapshot', { method: 'PUT', body: await gzip('{}') })).status).toBe(403);
  });

  it('keeps a mirror boat out of work and the helm', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    expect((await boatCall(north, 'workers/sign-on', { body: JSON.stringify({ worker: 'w', repo: 'repo', repoRemote: 'github.com/test/repo' }) })).status).toBe(403);
    expect((await boatCall(north, 'helm/take', { body: JSON.stringify({ session: 'seat' }) })).status).toBe(403);
    expect((await boatCall(north, 'mirror/calls')).status).toBe(200);
  });

  it('refuses a call for a boat that is not a mirror boat', async () => {
    const worker = await enrol('worker', ['work', 'read']);
    expect((await browser('mirror/calls', { body: { id: 'not-a-mirror', boat: worker.id, read: '/data/stats' } })).status).toBe(404);
  });
});

describe('the mirror permission', () => {
  it('stands apart from work and the steering layers', async () => {
    const { boatPermissions, permits } = await import('../src/permissions.js');
    expect(boatPermissions(['read', 'mirror'], false)).toEqual(['mirror', 'read']);
    expect(permits(['mirror', 'read'], 'mirror')).toBe(true);
    expect(permits(['mirror', 'read'], 'work')).toBe(false);
    expect(permits(['mirror', 'read'], 'helm')).toBe(false);
    expect(permits(['admin'], 'mirror')).toBe(false);
    expect(permits(['work', 'helm'], 'mirror')).toBe(false);
  });
});

describe('the waiting relay', () => {
  /** The boat's side: wait for one call, take it, answer it with what `body` gives. */
  async function boatAnswers(boat: Boat, status: number, body: (call: WharfMirrorCall) => string, contentType = 'application/json'): Promise<WharfMirrorCall> {
    for (let i = 0; i < 50; i++) {
      const { calls } = await (await boatCall(boat, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>();
      if (calls[0]) {
        await boatCall(boat, `mirror/calls/${calls[0].id}/take`, { body: '{}' });
        await answer(boat, calls[0].id, status, body(calls[0]), contentType);
        return calls[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no call arrived');
  }

  it('posts one call and answers with the boat’s own response once it comes', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const relayed = browser('mirror/relay', { body: { id: 'relay-1', boat: north.id, write: { kind: 'pr-ack', payload: { key: 'pr:1' } } } });
    const handled = await boatAnswers(north, 201, () => '{"ok":true}');
    expect(handled).toMatchObject({ id: 'relay-1', write: { kind: 'pr-ack' } });
    const response = await relayed;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('reads a boat’s file in one GET, as an image’s src would', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    const path = '/decision/decision%3A0a1b2c3d/files/tray.png';
    const read = browser(`mirror/read?boat=${north.id}&path=${encodeURIComponent(path)}`);
    const handled = await boatAnswers(north, 200, () => 'PNGDATA', 'image/png');
    expect(handled.read).toBe(path);
    const response = await read;
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(await response.text()).toBe('PNGDATA');
  });

  it('refuses a relay the hosted glass may not make, before any boat hears of it', async () => {
    const north = await enrol('north', ['mirror', 'read']);
    expect((await browser('mirror/relay', { body: { id: 'relay-2', boat: north.id, write: { kind: 'focus', payload: {} } } })).status).toBe(403);
    expect((await (await boatCall(north, 'mirror/calls')).json<{ calls: WharfMirrorCall[] }>()).calls).toEqual([]);
  });
});
