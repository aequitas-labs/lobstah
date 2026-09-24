import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { appendStatus, enqueue, ensureLayout, mergeEvidence, postNotice, takeHelm } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const UUID = '33333333-3333-3333-3333-333333333333';

describe('glass snapshot', () => {
  it('reads dispatches, standing questions, and the helm from disk', () => {
    enqueue({ id: UUID, repo: 'web', brief: 'do the thing' }, 'work');
    appendStatus(UUID, 'work', 'needs-decision', 'which color?');
    takeHelm({
      sessionId: 's-helm',
      grounds: { name: 'fleet', repos: ['web'] },
      ttlMs: 60_000,
      identity: { harness: 'claude', cwd: '/tmp/base/homebase', host: 'mbp' },
    });
    const snap = buildGlassSnapshot();
    const d = snap.dispatches.find((x) => x.id === UUID);
    expect(d?.verb).toBe('needs-decision');
    expect(d?.note).toBe('which color?');
    expect(snap.helms[0]?.man).toBe('claude @ homebase');
    expect(snap.version).toBeTruthy();
  });

  it('a signed-off trap survives as history via receipts and notices', () => {
    enqueue({ id: UUID, repo: 'web', brief: 'addressed work', for: 'wt:deadbeef' }, 'work');
    mergeEvidence(UUID, 'work', { deliveredTo: 'wt:deadbeef' });
    postNotice({ kind: 'trap-stowed', text: 'gone', refId: 'deadbeef' });
    const snap = buildGlassSnapshot();
    const t = snap.traps.find((x) => x.trapId === 'deadbeef');
    expect(t?.live).toBe(false);
    expect(t?.catches.map((c) => c.id)).toContain(UUID);
    expect(t?.notices.map((n) => n.kind)).toContain('trap-stowed');
  });

  it('serves the page, the data, and never anything but GET reads', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toBe(GLASS_PAGE);
    // One self-contained document: styles and script inline, nothing else to fetch but the served assets.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]* src=|<link[^>]*stylesheet/);
    expect(html).toContain('<title>spyglass</title>');
    const data = (await (await fetch(`http://127.0.0.1:${port}/data`)).json()) as { version: string };
    expect(data.version).toBeTruthy();
    server.close();
  });
});
