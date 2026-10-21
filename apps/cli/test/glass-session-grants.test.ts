import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, addGrant, listGrants, useGrant } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { requestSessionGrant } from '../src/grants-cli.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { glassDecisions, decisionAttention } from '../src/decisions.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';
let home: string;
let dom: GlassDom | undefined;
let server: Server | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-session-grants-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(async () => {
  await dom?.close();
  dom = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
it('shows session cards with only duration buttons, and active scopes/audit with Revoke', async () => {
  const c = requestSessionGrant({ session: 'helm-session', tools: 'mcp__browser__*', hosts: ['example.com'], reason: 'Inspect the site' });
  const g = addGrant({ mode: 'session', session: 'trap-session', tools: 'mcp__browser__*', hosts: ['example.com'], by: 'glass' });
  useGrant({
    harness: 'claude',
    tool: 'mcp__browser__navigate',
    session: 'trap-session',
    input: { url: 'https://example.com/private?secret=HIDDEN' },
  });
  const d = {
    ...emptyFleet(),
    focusToken: 'tok',
    decisions: glassDecisions(),
    attention: decisionAttention(Date.now()),
    sessionGrants: listGrants().grants,
  };
  dom = await loadGlass(GLASS_PAGE, d, { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
  (dom.$('.dopen') as unknown as HTMLElement).click();
  await dom.settle();
  expect(dom.$$('.doptions .dlabel').map((x) => x.textContent)).toEqual(['Allow for 15m', 'Allow for 1h', 'Deny']);
  expect(dom.$('.dpermission textarea')).toBeNull();
  dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await dom.settle();
  expect(dom.$('.session-grants')?.textContent).toContain('mcp__browser__*');
  expect(dom.$('.session-grants')?.textContent).toContain('example.com');
  expect(dom.$('.session-grants')?.textContent).toContain('1 uses');
  expect(dom.$('.session-grants')?.textContent).not.toContain('HIDDEN');
  (dom.$('.session-grants button') as unknown as HTMLElement).click();
  await dom.settle();
  expect(dom.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'grant-revoke', payload: { id: g.id } });
});
it('the glass revoke endpoint requires its page token and removes the grant immediately', async () => {
  const g = addGrant({ mode: 'session', session: 'helm-session', tools: 'WebFetch', by: 'glass' });
  expect(buildGlassSnapshot().sessionGrants?.map((g) => g.id)).toContain(g.id);
  server = serveGlass(0);
  await new Promise<void>((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (await (await fetch(`${base}/data`)).json()).focusToken;
  const post = (token: string) =>
    fetch(`${base}/requests`, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token },
      body: JSON.stringify({ kind: 'grant-revoke', payload: { id: g.id } }),
    });
  expect((await post('wrong')).status).toBe(403);
  expect((await post(token)).status).toBe(200);
  expect(listGrants().grants).toEqual([]);
  expect(buildGlassSnapshot().sessionGrants).toEqual([]);
});
