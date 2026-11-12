import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, addGrant, listGrants, signOnTrap, useGrant } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { requestSessionGrant } from '../src/grants-cli.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { glassDecisions, decisionAttention } from '../src/decisions.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { acceptanceFleet, emptyFleet, NOW } from './fixtures/glass-snapshots.js';
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
  expect(dom.$('.session-grants')).toBeNull();
  await dom.go('#grants');
  expect(dom.$('.session-grants')?.textContent).toContain('mcp__browser__*');
  // The card shows its tools, session and time left; a tap shows its uses, hosts and id.
  expect(dom.$('.session-grants .card')?.textContent).not.toContain('example.com');
  (dom.$('.session-grants .card') as unknown as HTMLElement).click();
  await dom.settle();
  expect(dom.$('.session-grants .card')?.textContent).toContain('example.com');
  expect(dom.$('.session-grants')?.textContent).toContain('1 use');
  expect(dom.$('.session-grants')?.textContent).not.toContain('HIDDEN');
  (dom.$('.session-grants button') as unknown as HTMLElement).click();
  await dom.settle();
  expect(dom.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'grant-revoke', payload: { id: g.id } });
});

it.each(['table', 'cards'])(
  'links covered helm and trap sessions to Grants in %s view; hides revoked and expired coverage',
  async (view) => {
    const d = acceptanceFleet();
    const helm = d.helms[0]!;
    const trap = d.traps.find((t) => t.live)!;
    const grant = addGrant({ mode: 'session', session: helm.sessionId, tools: 'WebFetch', by: 'glass' });
    const expiresAt = new Date(NOW + 12 * 60_000).toISOString();
    d.sessionGrants = [
      { ...grant, expiresAt },
      { ...grant, id: 'trap-grant', session: trap.sessionId, expiresAt },
      { ...grant, id: 'other-session', session: 'unrelated-session', expiresAt },
    ];
    dom = await loadGlass(GLASS_PAGE, d, { now: NOW, prefs: { view } });
    expect(dom.$('.session-grants')).toBeNull();
    expect(dom.$$('.chips .grant-chip').map((x) => x.textContent)).toEqual(['grant · 12m left']);
    // A trap card leaves its grant to the trap's modal; a table row keeps it.
    expect(dom.$$('main .grant-chip').map((x) => x.textContent)).toEqual(view === 'cards' ? [] : ['grant · 12m left']);
    await dom.go('#traps');
    if (view === 'cards') {
      (dom.$('main .card') as unknown as HTMLElement).click();
      await dom.settle();
    }
    const chip = dom.$(view === 'cards' ? '#modalbox .grant-chip' : 'main .grant-chip')!;
    expect(chip.textContent).toBe('grant · 12m left');
    expect(chip.getAttribute('href')).toBe('#grants');
    (chip as unknown as HTMLElement).click();
    await dom.settle();
    expect(dom.$('.session-grants')).not.toBeNull();
    expect(dom.$('#overlay')?.classList.contains('open')).toBe(false);
    (dom.$('.nav-toggle') as unknown as HTMLElement).click();
    await dom.settle();
    expect(dom.$('#more-sections a[data-tab="grants"]')?.textContent).toBe('Grants');
    d.sessionGrants = d.sessionGrants.map((g) => ({ ...g, revokedAt: new Date(NOW).toISOString() }));
    dom.serve(d);
    await dom.poll();
    expect(dom.$$('.grant-chip')).toHaveLength(0);
    expect(dom.$('.session-grants')?.textContent).toContain('No active grants');
    d.sessionGrants = [{ ...grant, expiresAt: new Date(NOW).toISOString() }];
    dom.serve(d);
    await dom.poll();
    expect(dom.$$('.grant-chip')).toHaveLength(0);
    await dom.go('#traps');
    expect(dom.$$('.grant-chip')).toHaveLength(0);
  },
);

it("shows the trap name first, keeps repo context secondary, and retains the table's repo column", async () => {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ sessionId: 'card-trap', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000, name: 'amber-gull' });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  const address = `wt:${signed.ok.trapId}`;
  dom = await loadGlass(GLASS_PAGE, { ...emptyFleet(), traps: buildGlassSnapshot().traps }, { now: NOW, hash: '#traps', prefs: { view: 'cards' } });
  expect(dom.$('main .card .gtitle')?.textContent).toBe('amber-gull');
  expect(dom.$('main .card .gtitle')?.getAttribute('title')).toBe(address);
  expect(dom.$('main .card .gcontext .gtext')?.textContent).toBe('web · 🦞 0');
  expect(dom.$('main .card .gtop')?.textContent).not.toContain('web');
  (dom.$('main .card') as unknown as HTMLElement).click();
  await dom.settle();
  expect(dom.$('#overlay h3')?.textContent).toContain('amber-gull');
  expect(dom.$('#overlay h3')?.textContent).not.toContain('web');
  expect(dom.$('#overlay .trap-address')?.textContent).toBe(`web · ${address}`);
  await dom.close();
  dom = await loadGlass(GLASS_PAGE, { ...emptyFleet(), traps: buildGlassSnapshot().traps }, { now: NOW, hash: '#traps', prefs: { view: 'table' } });
  expect(dom.$('main tr.rowhead td b')?.textContent).toBe('amber-gull');
  expect(dom.$('main tr.rowhead .trap-address')?.textContent).toBe(address);
  expect(dom.$$('main tr.rowhead td')[1]?.textContent).toBe('web');
});

it('shows only the latest 20 uses across active grants in descending time order', async () => {
  const grant = addGrant({ mode: 'session', session: 'audit-session', tools: 'mcp__browser__*', by: 'glass' });
  const d = emptyFleet();
  const audit = Array.from({ length: 15 }, (_, i) => ({ at: new Date(NOW - i * 60_000).toISOString(), tool: `mcp__browser__tool_${i}` }));
  d.sessionGrants = [
    { ...grant, audit, expiresAt: new Date(NOW + 60_000).toISOString() },
    {
      ...grant,
      id: 'second',
      session: 'second-session',
      audit: audit.map((a) => ({ ...a, at: new Date(Date.parse(a.at) - 30_000).toISOString() })),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    },
  ];
  dom = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#grants' });
  const times = dom.$$('.grant-audit time').map((x) => x.getAttribute('datetime'));
  expect(times).toHaveLength(20);
  expect(times).toEqual([...times].sort().reverse());
  expect(times[0]).toBe(new Date(NOW).toISOString());
  expect(times[19]).toBe(new Date(NOW - 9.5 * 60_000).toISOString());
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
