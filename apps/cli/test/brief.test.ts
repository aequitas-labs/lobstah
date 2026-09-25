import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ensureLayout, loadConfig, resolveGrounds, takeHelm } from '@lobstah/core';
import { buildBriefContext } from '../src/brief.js';
import { serveGlass } from '../src/glass.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-brief-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_GLASS_PORT;
});

describe('man brief — the session-start sign-on offer', () => {
  it('a non-holder, non-soaking session gets both sign-on lines with its id', async () => {
    const ctx = await buildBriefContext('sess-1234', home);
    expect(ctx).toContain('session id sess-1234');
    expect(ctx).toContain('to take the helm:    lobstah man helm --session sess-1234');
    expect(ctx).toContain('to work as a trap:   lobstah soak --session sess-1234');
    expect(ctx).toContain('never the primary checkout');
    expect(ctx.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('with a live helm on the grounds, names the holder and offers only soak and --take', async () => {
    const cfg = loadConfig();
    takeHelm({ sessionId: 'holder-abcdef', grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000 });
    const ctx = await buildBriefContext('sess-5678', home);
    expect(ctx).toContain('held by');
    expect(ctx).toContain('holder-a');
    expect(ctx).toContain('lobstah soak --session sess-5678');
    expect(ctx).toContain('lobstah man helm --take --session sess-5678');
    expect(ctx).not.toContain('to take the helm:');
  });

  it('the helm holder gets its charter, not the sign-on offer', async () => {
    const cfg = loadConfig();
    takeHelm({ sessionId: 'holder-abcdef', grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000 });
    const ctx = await buildBriefContext('holder-abcdef', home);
    expect(ctx).toContain('you hold the helm');
    expect(ctx).not.toContain('to work as a trap');
  });

  it('prints the URL only when a glass is answering', async () => {
    const server = serveGlass(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.LOBSTAH_GLASS_PORT = String(port);
    try {
      expect(await buildBriefContext('sess-1234', home)).toContain(`Glass: http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await buildBriefContext('sess-1234', home)).not.toContain('Glass:');
    delete process.env.LOBSTAH_GLASS_PORT;
  });
});
