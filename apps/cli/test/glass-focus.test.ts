import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, signOnTrap, soakingDir, stowTrap } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let worktree: string;
let trapId: string;
let server: Server | undefined;
let base: string;
let token: string;
const focus = vi.fn(async () => ({ focused: true as const, step: 'app' as const, message: 'Brought the app forward; the exact window is not known.' }));

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-focus-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, sessionId: 'session-one', harness: 'claude', ttlMs: 60_000, window: { bundleId: 'com.apple.Safari' }, link: 'claude://claude.ai/local_1' });
  if ('held' in signed) throw new Error('unexpected hold');
  trapId = signed.ok.trapId;
  focus.mockClear();
  server = serveGlass(0, { focus });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = ((await (await fetch(`${base}/data`)).json()) as { focusToken: string }).focusToken;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const request = (id: string, init: RequestInit = {}) => fetch(`${base}/api/focus/${id}`, {
  method: 'POST',
  headers: { Origin: base, 'x-lobstah-focus-token': token },
  ...init,
});
const wrongHostStatus = (id: string): Promise<number | undefined> => new Promise((resolve, reject) => {
  const req = httpRequest(`${base}/api/focus/${id}`, {
    method: 'POST',
    headers: { Host: 'evil.example', Origin: base, 'x-lobstah-focus-token': token },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});

describe('glass focus endpoint', () => {
  it('uses POST, exact origin and host, and a per-server token', async () => {
    expect((await request(trapId, { method: 'GET' })).status).toBe(405);
    expect((await request(trapId, { headers: { Origin: base } })).status).toBe(403);
    expect((await request(trapId, { headers: { Origin: base, 'x-lobstah-focus-token': 'wrong' } })).status).toBe(403);
    expect((await request(trapId, { headers: { Origin: 'http://evil.example', 'x-lobstah-focus-token': token } })).status).toBe(403);
    expect(await wrongHostStatus(trapId)).toBe(403);
    expect(focus).not.toHaveBeenCalled();
    const result = await request(trapId);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ focused: true, step: 'app', message: expect.stringContaining('exact window') });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.calls[0]?.[0]).toMatchObject({ trapId });
    expect(server?.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('refuses a non-live trap and runs no focus step', async () => {
    stowTrap(trapId);
    const result = await request(trapId);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ focused: false, reason: 'Trap is not live.' });
    expect(focus).not.toHaveBeenCalled();
  });

  it('refuses body and malformed ids, and strips invalid links before rendering', async () => {
    expect((await request(trapId, { body: 'path=/tmp' })).status).toBe(403);
    expect((await request('bad%2Fpath')).status).toBe(400);
    const file = path.join(soakingDir(), `${trapId}.json`);
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    reg.link = 'javascript:alert(1)';
    fs.writeFileSync(file, JSON.stringify(reg));
    expect(buildGlassSnapshot().traps.find((t) => t.trapId === trapId)?.link).toBeUndefined();
    expect(focus).not.toHaveBeenCalled();
  });
});
