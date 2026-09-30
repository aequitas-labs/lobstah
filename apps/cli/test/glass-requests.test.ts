import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  closeRequest,
  dropReservation,
  ensureLayout,
  listNotices,
  listRequests,
  reserveTrap,
  shellQuote,
  signOnTrap,
} from '@lobstah/core';
import type { GlassSnapshot } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';

let home: string;
let repoDir: string;
let server: Server | undefined;
let base: string;
let token: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-requests-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repoDir = path.join(home, 'web');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = '${repoDir}'\ntrunk = 'main'\n`);
  server = serveGlass(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = ((await (await fetch(`${base}/data`)).json()) as { focusToken: string }).focusToken;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const trapRequest = (payload: unknown) => ({ kind: 'trap-request', payload });
const post = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  fetch(`${base}/requests`, {
    method,
    headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token, ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

/** A raw request with a chosen Host header: what a rebound DNS name would send. */
const withHost = (url: string, host: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status?: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${url}`, { method, headers: { Host: host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('glass /requests', () => {
  it('refuses a missing or wrong token, a foreign origin or host, and GET, writing nothing', async () => {
    const good = trapRequest({ repo: 'web', harness: 'claude' });
    expect((await post(good, { 'x-lobstah-token': '' })).status).toBe(403);
    expect((await post(good, { 'x-lobstah-token': 'wrong' })).status).toBe(403);
    expect((await post(good, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await withHost('/requests', 'evil.example', 'POST', JSON.stringify(good), { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token })).status).toBe(403);
    expect((await post(undefined, {}, 'GET')).status).toBe(405);
    expect(listRequests()).toEqual([]);
    expect(listNotices(50)).toEqual([]);
  });

  it('refuses an unknown kind, repo, or harness, extra fields, and non-JSON', async () => {
    const reasons: string[] = [];
    for (const body of [
      { kind: 'launch', payload: { repo: 'web', harness: 'claude' } },
      trapRequest({ repo: 'nope', harness: 'claude' }),
      trapRequest({ repo: 'web', harness: 'vim' }),
      trapRequest({ repo: 'web', harness: 'claude', command: 'rm -rf /' }),
      trapRequest(['web']),
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      reasons.push(((await res.json()) as { reason: string }).reason);
    }
    expect(reasons).toEqual([
      'Unknown request kind.',
      'Invalid trap request: unknown repo.',
      'Invalid trap request: unknown harness.',
      'Invalid trap request: unknown field command.',
      'Invalid trap request: payload must be an object.',
    ]);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(trapRequest({ repo: 'web', harness: 'claude' }), { 'content-type': 'text/plain' })).status).toBe(415);
    const big = await post(trapRequest({ repo: 'web', harness: 'claude', pad: 'x'.repeat(8192) }));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { reason: string }).reason).toBe('The request is too large.');
    expect(listRequests()).toEqual([]);
    expect(listNotices(50)).toEqual([]);
  });

  it('a valid request writes one trap-request and one wake notice, and runs nothing', async () => {
    const res = await post(trapRequest({ repo: 'web', harness: 'codex' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const requests = listRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id, kind: 'trap-request', from: 'glass', payload: { repo: 'web', harness: 'codex' } });
    expect(fs.existsSync(path.join(home, 'requests', `${id}.json`))).toBe(true);
    expect(requests[0]!.closedAt).toBeUndefined();
    const notices = listNotices(50);
    expect(notices.map((n) => [n.kind, n.refId])).toEqual([['trap-request', id]]);
    expect(notices[0]!.text).toContain(`lobstah trap reserve --request ${id}`);
    expect(notices[0]!.text).toContain('repo web, harness codex');
  });

  it('the glass shows the request, then the starting trap, then the live trap', async () => {
    const { id } = (await (await post(trapRequest({ repo: 'web', harness: 'claude' }))).json()) as { id: string };
    const requested = buildGlassSnapshot().traps.filter((t) => t.requested);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ trapId: id, repo: 'web', harness: 'claude', live: false });
    expect(buildGlassSnapshot().helmOn).toBe(false);

    // The helm reserves it: the request closes, the reservation shows as starting.
    const { reservation } = reserveTrap({ repo: 'web', harness: 'claude', request: id });
    closeRequest(id, 'reserved');
    let snap = buildGlassSnapshot();
    expect(snap.traps.some((t) => t.requested)).toBe(false);
    const starting = snap.traps.find((t) => t.trapId === reservation.trapId);
    expect(starting?.starting).toBeDefined();

    // The session signs on: the live trap replaces the starting one.
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt);
    signOnTrap({ worktree: wt, cwd: wt, repo: 'web', harness: 'claude', sessionId: 's1', trapId: reservation.trapId, ttlMs: 60_000 });
    dropReservation(reservation.trapId);
    snap = buildGlassSnapshot();
    const live = snap.traps.filter((t) => t.trapId === reservation.trapId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ live: true });
    expect(live[0]!.starting).toBeUndefined();
  });

  it("start commands carry the ticket only to this machine's own page", async () => {
    const { reservation, ticket } = reserveTrap({ repo: 'web', harness: 'claude' });
    expect(buildGlassSnapshot().traps.find((t) => t.trapId === reservation.trapId)?.starting?.commands).toBeUndefined();
    const own = (await (await fetch(`${base}/data`)).json()) as GlassSnapshot;
    const commands = own.traps.find((t) => t.trapId === reservation.trapId)?.starting?.commands;
    expect(commands).toEqual([{ harness: 'claude', command: `cd ${shellQuote(repoDir)} && CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude "/lobstah:soak --ticket ${ticket}"` }]);
    const rebound = await withHost('/data', 'evil.example');
    expect(rebound.status).toBe(200);
    expect(rebound.text).not.toContain(ticket);
    // Never logged: no notice carries it.
    expect(listNotices(50).some((n) => n.text.includes(ticket))).toBe(false);
  });
});
