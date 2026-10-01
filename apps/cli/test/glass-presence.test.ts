import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import {
  GlassPresence,
  PRESENCE_RECENT_MS,
  ensureShowSecret,
  glassHost,
  readShowSecret,
  requestShow,
  showSecretPath,
  validShowHash,
} from '../src/glass-presence.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Presence and show: open glass pages report themselves, and the local pet or
 * CLI asks the page in front to show an item instead of opening a new tab.
 */

/** The Claude desktop app's Browser pane drops only ` Electron/<v>` from Electron's user agent (app.asar, 2.16120.0). */
const CLAUDE_PANE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.16120.0 Chrome/138.0.7204.251 Safari/537.36';
const CLAUDE_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.16120.0 Chrome/138.0.7204.251 Electron/37.2.3 Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-presence-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('glassHost', () => {
  it('reads the Claude desktop pane, with or without its Electron token', () => {
    expect(glassHost(CLAUDE_PANE_UA)).toBe('claude');
    expect(glassHost(CLAUDE_ELECTRON_UA)).toBe('claude');
  });
  it('reads the browsers', () => {
    expect(glassHost(CHROME_UA)).toBe('chrome');
    expect(glassHost(SAFARI_UA)).toBe('safari');
    expect(glassHost('Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('firefox');
    expect(glassHost(`${CHROME_UA} Edg/154.0.0.0`)).toBe('edge');
    expect(glassHost('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Code/1.104.0 Chrome/138.0 Electron/37.2.3 Safari/537.36')).toBe('electron');
    expect(glassHost('')).toBe('other');
  });
});

describe('validShowHash: what location.hash accepts', () => {
  it('takes a tab, a decision, a report, or nothing', () => {
    for (const ok of ['', '#prs', '#deck', '#decision/fleet%2Fabc', '#decision/work:1234', '#report/r-1']) expect(validShowHash(ok), ok).toBe(true);
  });
  it('refuses anything else', () => {
    for (const bad of ['prs', '#nope', '#decision/', '#decision/%E0', '#report/a b', 'javascript:alert(1)', '#report/x\n', `#report/${'x'.repeat(1100)}`, 7, null]) {
      expect(validShowHash(bad), String(bad)).toBe(false);
    }
  });
});

describe('GlassPresence', () => {
  it('has no target until a page is seen, and forgets a page after three minutes', () => {
    let now = 1_000_000;
    const p = new GlassPresence(() => now);
    expect(p.show('#prs')).toEqual({ delivered: false });
    p.seen('page-aaaaaaaa', true, CHROME_UA);
    now += PRESENCE_RECENT_MS + 1;
    expect(p.target()).toBeUndefined();
    expect(p.show('#prs')).toEqual({ delivered: false });
  });

  it('targets the visible page over a more recently seen hidden one', () => {
    let now = 1_000_000;
    const p = new GlassPresence(() => now);
    p.seen('page-claude', true, CLAUDE_PANE_UA);
    now += 1000;
    p.seen('page-chrome', false, CHROME_UA);
    expect(p.target()).toMatchObject({ id: 'page-claude', host: 'claude' });
    // Once nothing is on screen, the latest page seen wins.
    now += 20_000;
    p.seen('page-chrome', false, CHROME_UA);
    expect(p.target()).toMatchObject({ id: 'page-chrome', host: 'chrome' });
  });

  it('hands a show to its page once, with the host and age the pet routes by', () => {
    let now = 1_000_000;
    const p = new GlassPresence(() => now);
    p.seen('page-claude', true, CLAUDE_PANE_UA);
    now += 1500;
    const r = p.show('#decision/abc');
    expect(r).toMatchObject({ delivered: true, page: 'page-claude', host: 'claude', visible: true, seenAgoMs: 1500, userAgent: CLAUDE_PANE_UA });
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(p.seen('page-other', true, CHROME_UA)).toBeNull();
    expect(p.seen('page-claude', true, CLAUDE_PANE_UA)).toEqual({ id: r.id, hash: '#decision/abc' });
    expect(p.seen('page-claude', true, CLAUDE_PANE_UA)).toBeNull();
  });

  it('keeps only the newest show per page, and drops it with its page', () => {
    let now = 1_000_000;
    const p = new GlassPresence(() => now);
    p.seen('page-chrome', false, CHROME_UA);
    p.show('#prs');
    const second = p.show('#report/r-1');
    expect(p.seen('page-chrome', false, CHROME_UA)).toEqual({ id: second.id, hash: '#report/r-1' });
    p.show('#prs');
    // The page stops reporting: past three minutes it and its show are gone.
    now += PRESENCE_RECENT_MS + 1;
    expect(p.target()).toBeUndefined();
    expect(p.seen('page-chrome', true, CHROME_UA)).toBeNull();
  });

  it('forgets a page that said goodbye', () => {
    const p = new GlassPresence(() => 1_000_000);
    p.seen('page-chrome', true, CHROME_UA);
    p.show('#prs');
    p.gone('page-chrome');
    expect(p.target()).toBeUndefined();
    expect(p.seen('page-chrome', true, CHROME_UA)).toBeNull();
  });
});

describe('the show secret', () => {
  it('is created user-only and read back', () => {
    expect(readShowSecret()).toBeUndefined();
    const secret = ensureShowSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureShowSecret()).toBe(secret);
    if (process.platform !== 'win32') {
      expect(fs.statSync(showSecretPath()).mode & 0o777).toBe(0o600);
      // A file others can read is no secret.
      fs.chmodSync(showSecretPath(), 0o644);
      expect(readShowSecret()).toBeUndefined();
    }
  });
});

describe('the glass server', () => {
  let server: Server;
  let base: string;
  let host: string;
  let now: number;
  let secret: string;
  beforeEach(async () => {
    now = 1_000_000;
    server = serveGlass(0, { presence: new GlassPresence(() => now), snapshot: () => acceptanceFleet() as never });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `http://${host}`;
    secret = ensureShowSecret();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A raw request: node's fetch will not send a Host of our choosing. */
  const raw = (
    pathname: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${pathname}`, { method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  const presence = (page: string, vis: string, ua: string, headers: Record<string, string> = { Origin: base }) =>
    raw(`/api/presence?page=${page}&vis=${vis}`, { headers: { 'User-Agent': ua, ...headers } });
  const show = (hash: unknown, headers: Record<string, string> = {}) =>
    raw('/api/show', {
      headers: { 'content-type': 'application/json', 'x-lobstah-show-secret': secret, ...headers },
      body: JSON.stringify({ hash }),
    });

  it('records a same-origin page, and refuses presence from another origin or host', async () => {
    expect((await presence('page-aaaaaaaa', 'visible', CHROME_UA, {})).status).toBe(403);
    expect((await presence('page-aaaaaaaa', 'visible', CHROME_UA, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await presence('page-aaaaaaaa', 'visible', CHROME_UA, { Origin: base, Host: 'evil.example' })).status).toBe(403);
    expect((await raw('/api/presence?page=page-aaaaaaaa&vis=visible', { method: 'GET', headers: { Origin: base } })).status).toBe(405);
    expect((await presence('bad id!', 'visible', CHROME_UA)).status).toBe(400);
    expect((await presence('page-aaaaaaaa', 'maybe', CHROME_UA)).status).toBe(400);
    expect((await show('#prs')).body).toEqual({ delivered: false });
    expect(await presence('page-aaaaaaaa', 'visible', CHROME_UA)).toEqual({ status: 200, body: { ok: true, show: null } });
    expect((await show('#prs')).body).toMatchObject({ delivered: true, page: 'page-aaaaaaaa', host: 'chrome' });
  });

  it('queues a show for the page, which receives it once on its next presence', async () => {
    await presence('page-claude1', 'hidden', CLAUDE_PANE_UA);
    now += 20_000;
    const r = await show('#decision/fleet%2Fabc');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ delivered: true, page: 'page-claude1', host: 'claude', visible: false, seenAgoMs: 20_000 });
    const next = await presence('page-claude1', 'visible', CLAUDE_PANE_UA);
    expect(next.body).toEqual({ ok: true, show: { id: r.body.id, hash: '#decision/fleet%2Fabc' } });
    expect((await presence('page-claude1', 'visible', CLAUDE_PANE_UA)).body).toEqual({ ok: true, show: null });
  });

  it('forgets a page on its goodbye beacon', async () => {
    await presence('page-chrome1', 'visible', CHROME_UA);
    expect((await presence('page-chrome1', 'gone', CHROME_UA)).status).toBe(200);
    expect((await show('#prs')).body).toEqual({ delivered: false });
  });

  it('refuses a show that carries an Origin, a wrong Host, or a wrong secret', async () => {
    await presence('page-chrome1', 'visible', CHROME_UA);
    expect((await show('#prs', { Origin: base })).status).toBe(403);
    expect((await show('#prs', { Origin: 'null' })).status).toBe(403);
    expect((await show('#prs', { Host: 'evil.example' })).status).toBe(403);
    expect((await show('#prs', { Host: `localhost:${new URL(base).port}` })).status).toBe(403);
    expect((await show('#prs', { 'x-lobstah-show-secret': 'f'.repeat(64) })).status).toBe(403);
    expect((await show('#prs', { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await raw('/api/show', { method: 'GET', headers: { 'x-lobstah-show-secret': secret } })).status).toBe(405);
    // Nothing was queued by the refused requests.
    expect((await presence('page-chrome1', 'visible', CHROME_UA)).body).toEqual({ ok: true, show: null });
  });

  it('refuses a hash the page would not read', async () => {
    await presence('page-chrome1', 'visible', CHROME_UA);
    for (const bad of ['javascript:alert(1)', '#nope', '#report/a b', 42]) {
      expect((await show(bad)).status, String(bad)).toBe(400);
    }
    expect((await raw('/api/show', { headers: { 'content-type': 'application/json', 'x-lobstah-show-secret': secret }, body: '{' })).status).toBe(400);
  });

  it('answers the CLI client, and says so when no glass runs', async () => {
    expect(await requestShow(Number(new URL(base).port), '#prs')).toEqual({ delivered: false });
    await presence('page-safari1', 'visible', SAFARI_UA);
    expect(await requestShow(Number(new URL(base).port), '#report/r-1')).toMatchObject({ delivered: true, host: 'safari' });
    const closed = serveGlass(0, { snapshot: () => acceptanceFleet() as never });
    await new Promise<void>((resolve) => closed.once('listening', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(requestShow(port, '#prs')).rejects.toThrow(`no glass is running on port ${port}`);
  });
});

describe('the glass page', () => {
  let open: GlassDom[] = [];
  afterEach(async () => {
    await Promise.all(open.map((g) => g.close()));
    open = [];
  });
  const page = async (opts: Partial<GlassDomOptions> = {}) => {
    const g = await loadGlass(GLASS_PAGE, acceptanceFleet(), { now: NOW, ...opts });
    open.push(g);
    return g;
  };
  const vis = (url: string | undefined) => new URLSearchParams(url?.split('?')[1]).get('vis');

  it('reports its presence with every poll, and a heartbeat every 30 s while hidden', async () => {
    const g = await page();
    const first = g.presence();
    expect(first.length).toBeGreaterThan(0);
    const id = new URLSearchParams(first[0]!.split('?')[1]).get('page');
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await g.poll();
    expect(g.presence().length).toBe(first.length + 1);
    expect(vis(g.presence().at(-1))).toBe('visible');
    await g.hide(true);
    expect(g.intervals()).toEqual([30_000]);
    expect(vis(g.presence().at(-1))).toBe('hidden');
    const before = g.presence().length;
    await g.poll(); // the heartbeat interval
    expect(g.presence().length).toBe(before + 1);
    expect(g.presence().every((u) => new URLSearchParams(u.split('?')[1]).get('page') === id)).toBe(true);
    // Presence calls are not the page's requests.
    expect(g.posts()).toEqual([]);
  });

  it('applies a queued hash once per request id', async () => {
    const g = await page();
    expect(g.window.location.hash).toBe('');
    g.queueShow({ id: 'show-1', hash: '#prs' });
    await g.poll();
    expect(g.window.location.hash).toBe('#prs');
    await g.go('#traps');
    // The same id again (a retried answer) does not move the page.
    g.queueShow({ id: 'show-1', hash: '#prs' });
    await g.poll();
    expect(g.window.location.hash).toBe('#traps');
    g.queueShow({ id: 'show-2', hash: '#decision/abc' });
    await g.poll();
    expect(g.window.location.hash).toBe('#decision/abc');
  });

  it('ignores a hash location.hash would not take, and sends a report to its page', async () => {
    const g = await page({ hash: '#deck' });
    g.queueShow({ id: 'bad-1', hash: 'javascript:alert(1)' });
    await g.poll();
    expect(g.window.location.hash).toBe('#deck');
    g.queueShow({ id: 'rep-1', hash: '#report/r-1' });
    await g.poll();
    expect(g.assigned()).toEqual(['/report/r-1']);
  });

  it('applies a show that arrives while hidden, on the heartbeat', async () => {
    const g = await page({ hidden: true });
    expect(g.intervals()).toEqual([30_000]);
    g.queueShow({ id: 'show-h', hash: '#notices' });
    await g.poll();
    expect(g.window.location.hash).toBe('#notices');
  });
});
