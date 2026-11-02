import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, listNotices, signOnTrap, soakingDir, stowTrap, trapMessageTexts } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let worktree: string;
let trapId: string;
let server: Server | undefined;
let base: string;
let token: string;
const focus = vi.fn(async () => ({ focused: true as const, step: 'app' as const, message: 'Brought the app forward; the exact window is not known.' }));

const paneScreen = vi.fn(async () => 'SECRET_ON_SCREEN');

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
  server = serveGlass(0, { focus, paneScreen });
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
/** /data as a proxy with its own hostname would ask for it. */
const dataFromProxy = (): Promise<{ focusToken?: string; viewer?: { onMachine: boolean; windowFocus: boolean; machine: string } }> => new Promise((resolve, reject) => {
  const req = httpRequest(`${base}/data`, { headers: { Host: 'glass.example.net' } }, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    res.on('end', () => resolve(JSON.parse(body) as { focusToken?: string }));
  });
  req.on('error', reject);
  req.end();
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

describe('glass viewer', () => {
  it('gives the page token and open only to its own address', async () => {
    const own = (await (await fetch(`${base}/data`)).json()) as { focusToken?: string; viewer: { onMachine: boolean; windowFocus: boolean; machine: string } };
    expect(own.focusToken).toBe(token);
    expect(own.viewer.onMachine).toBe(true);
    expect(own.viewer.windowFocus).toBe(process.platform === 'darwin');
    const proxied = await dataFromProxy();
    expect(proxied.focusToken).toBeUndefined();
    expect(proxied.viewer).toEqual({ onMachine: false, windowFocus: false, machine: own.viewer.machine });
  });

  it('writes the attach command for the viewer, only for a live tmux trap', () => {
    const fleet = fs.readdirSync(soakingDir());
    expect(fleet).toHaveLength(1);
    const file = path.join(soakingDir(), fleet[0]!);
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...reg, window: { tmuxPane: '%7' } }));
    const trap = (local: boolean) => buildGlassSnapshot({ local }).traps.find((t) => t.trapId === trapId)!;
    expect(trap(true).attachCommand).toBe('tmux -L lobstah attach -t %7');
    expect(trap(false).attachCommand).toMatch(/^ssh \S+ -t tmux -L lobstah attach -r -t %7$/);
    stowTrap(trapId);
    expect(trap(true).attachCommand).toBeUndefined();
  });
});

describe('glass trap pane and message', () => {
  const pane = (id: string, init: RequestInit = {}) => fetch(`${base}/api/pane/${id}`, {
    method: 'POST',
    headers: { Origin: base, 'x-lobstah-focus-token': token },
    ...init,
  });
  const message = (payload: unknown, headers: Record<string, string> = { Origin: base, 'x-lobstah-token': token }) => fetch(`${base}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ kind: 'trap-message', payload }),
  });

  it('gives the screen to a POST with its own origin and the token', async () => {
    const res = await pane(trapId);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ screen: 'SECRET_ON_SCREEN' });
  });

  it('refuses every other pane request with 403 and reads no screen', async () => {
    paneScreen.mockClear();
    expect((await pane(trapId, { method: 'GET', headers: {} })).status).toBe(405);
    expect((await pane(trapId, { headers: { Origin: base } })).status).toBe(403);
    expect((await pane(trapId, { headers: { Origin: 'http://evil.example', 'x-lobstah-focus-token': token } })).status).toBe(403);
    expect((await pane(trapId, { headers: { 'x-lobstah-focus-token': token } })).status).toBe(403);
    const fromProxy = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/api/pane/${trapId}`, { method: 'POST', headers: { Host: 'glass.example.net', Origin: 'https://glass.example.net', 'x-lobstah-focus-token': token } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    expect(fromProxy).toBe(403);
    expect(paneScreen).not.toHaveBeenCalled();
  });

  it('keeps the screen out of /data', async () => {
    await pane(trapId);
    expect(await (await fetch(`${base}/data`)).text()).not.toContain('SECRET_ON_SCREEN');
  });

  it('delivers a message marked from the glass, and tells the helm quietly', async () => {
    expect((await message({ trap: trapId, text: '  check the failing test  ' })).status).toBe(200);
    expect(trapMessageTexts(trapId).join('\n')).toContain('check the failing test');
    const snapshot = buildGlassSnapshot({ local: true }).traps.find((t) => t.trapId === trapId)!;
    expect(snapshot.messages.at(-1)).toMatchObject({ from: 'glass' });
    const notice = listNotices(50).find((n) => n.kind === 'trap-glass-message');
    expect(notice).toMatchObject({ refId: trapId });
    expect(JSON.stringify(notice)).not.toContain('check the failing test');
  });

  it('refuses a message without the token, without text, or to a trap that is not live', async () => {
    expect((await message({ trap: trapId, text: 'hi' }, { Origin: base })).status).toBe(403);
    expect((await message({ trap: trapId, text: '   ' })).status).toBe(400);
    expect((await message({ trap: trapId, text: 'x'.repeat(8001) })).status).toBe(400);
    expect((await message({ trap: 'nosuchtrap', text: 'hi' })).status).toBe(409);
    expect(trapMessageTexts(trapId)).toEqual([]);
  });
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
    expect(await result.json()).toMatchObject({ focused: false, reason: 'Trap is not live' });
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
