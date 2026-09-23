import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ensureLayout, readSettings } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { checkSettingsWrite } from '../src/glass-settings.js';

let home: string;
let server: http.Server;
let port: number;
let token: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-settings-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  server = serveGlass(0);
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  token = /<meta name="glass-token" content="([0-9a-f]+)">/.exec(page)?.[1] ?? '';
});
afterEach(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

/** Raw http so we control Origin/Sec-Fetch-Site/Host exactly (fetch forbids some). */
function post(body: unknown, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/settings', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf || '{}') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const good = () => ({ 'x-glass-token': token, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });

describe('glass settings endpoint', () => {
  it('embeds a per-launch token in the page', () => {
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('GET /settings returns the defaults before anything is written', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/settings`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-settings-stored')).toBe('0');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(await r.json()).toEqual({ glass: { view: 'table' }, pet: { enabled: true } });
  });

  it('accepts a good request, writes, and returns the new document', async () => {
    const r = await post({ glass: { view: 'cards' } }, good());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ glass: { view: 'cards' }, pet: { enabled: true } });
    const r2 = await post({ pet: { enabled: false } }, good());
    expect(r2.json).toEqual({ glass: { view: 'cards' }, pet: { enabled: false } });
    expect(readSettings()).toEqual({ glass: { view: 'cards' }, pet: { enabled: false } });
  });

  it('rejects a request without the token (403, nothing written)', async () => {
    const { 'x-glass-token': _drop, ...noToken } = good();
    const r = await post({ glass: { view: 'cards' } }, noToken);
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(home, 'settings.json'))).toBe(false);
  });

  it('rejects a wrong token', async () => {
    const r = await post({ glass: { view: 'cards' } }, { ...good(), 'x-glass-token': 'f'.repeat(48) });
    expect(r.status).toBe(403);
    const short = await post({ glass: { view: 'cards' } }, { ...good(), 'x-glass-token': 'abc' });
    expect(short.status).toBe(403);
  });

  it('rejects a foreign Origin even with the right token', async () => {
    const r = await post({ glass: { view: 'cards' } }, { ...good(), origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const port2 = await post({ glass: { view: 'cards' } }, { ...good(), origin: `http://127.0.0.1:${port + 1}` });
    expect(port2.status).toBe(403);
  });

  it('rejects cross-site fetch metadata', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await post({ glass: { view: 'cards' } }, { ...good(), 'sec-fetch-site': site });
      expect(r.status, site).toBe(403);
    }
  });

  it('rejects unknown keys and bad values with 400', async () => {
    for (const bad of [{ theme: 'dark' }, { glass: { view: 'grid' } }, { pet: { enabled: 'no' } }, { pet: { enabled: true, extra: 1 } }]) {
      const r = await post(bad, good());
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('{nope', good())).status).toBe(400);
    expect(fs.existsSync(path.join(home, 'settings.json'))).toBe(false);
  });

  it('refuses other methods on /settings', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/settings`, { method: 'PUT' });
    expect(r.status).toBe(405);
  });
});

describe('checkSettingsWrite', () => {
  const T = 'a'.repeat(48);
  it('fetch metadata and Origin are checked only when present; the token always', () => {
    expect(checkSettingsWrite({ 'x-glass-token': T }, T, 4949)).toEqual({ ok: true });
    expect(checkSettingsWrite({ 'x-glass-token': T, 'sec-fetch-site': 'none' }, T, 4949)).toEqual({ ok: true });
    expect(checkSettingsWrite({ 'x-glass-token': T, origin: 'http://localhost:4949', host: 'localhost:4949' }, T, 4949)).toEqual({ ok: true });
    expect(checkSettingsWrite({}, T, 4949).ok).toBe(false);
    expect(checkSettingsWrite({ 'x-glass-token': T, host: 'evil.example:4949' }, T, 4949).ok).toBe(false);
  });
});
