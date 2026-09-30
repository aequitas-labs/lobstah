import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { appendStatus, claimNext, enqueue, ensureLayout, expireReservations, laneDirs, mergeEvidence, postNotice, reserveTrap, takeHelm, writeActivity } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const UUID = '33333333-3333-3333-3333-333333333333';

describe('glass snapshot', () => {
  it('marks a budget stop as work saved for continuation in the payload', () => {
    enqueue({ id: UUID, repo: 'web', brief: 'do the thing' }, 'work');
    appendStatus(UUID, 'work', 'failed', 'budget: out of time; checkpoint committed; send continue to resume');
    const d = buildGlassSnapshot().dispatches.find((x) => x.id === UUID);
    expect(d).toMatchObject({ verb: 'failed', outOfTimeWorkSaved: true });
  });

  it('reports headless and trap activity separately for the header', () => {
    enqueue({ id: 'headless', repo: 'web', brief: 'work' });
    claimNext('work');
    enqueue({ id: 'trap', repo: 'web', brief: 'work' });
    claimNext('work');
    fs.writeFileSync(path.join(laneDirs('work').active, 'trap', 'claim.json'), JSON.stringify({ by: 'wt:trap1' }));
    expect(buildGlassSnapshot().slots).toEqual({ headless: 1, limit: 2, traps: 1, parked: 0 });
  });

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

  it('a queued descriptor with no log is queued, timed by its queue time', () => {
    enqueue({ id: UUID, repo: 'web', brief: 'waiting', for: 'wt:deadbeef', queuedAt: '2026-09-24T11:59:00.000Z' }, 'work');
    const d = buildGlassSnapshot().dispatches.find((x) => x.id === UUID);
    expect(d).toMatchObject({ bucket: 'queued', verb: 'queued', verbAt: '2026-09-24T11:59:00.000Z', for: 'wt:deadbeef' });
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

  it('a reserved trap shows as starting, once, with its addressed work; past its deadline as failed', () => {
    const { reservation } = reserveTrap({ repo: 'web', name: 'amber-gull', harness: 'codex', startSecs: 60 });
    enqueue({ id: UUID, repo: 'web', brief: 'addressed work', for: `wt:${reservation.trapId}` }, 'work');
    const starting = buildGlassSnapshot().traps.filter((x) => x.trapId === reservation.trapId);
    expect(starting).toHaveLength(1);
    expect(starting[0]).toMatchObject({ live: false, name: 'amber-gull', repo: 'web', harness: 'codex', starting: { deadline: reservation.deadline } });
    expect(starting[0]!.starting!.failedAt).toBeUndefined();
    expect(starting[0]!.catches.map((c) => c.id)).toEqual([UUID]);
    expireReservations(Date.now() + 61_000);
    const failed = buildGlassSnapshot().traps.find((x) => x.trapId === reservation.trapId);
    expect(failed?.starting?.failedAt).toBeDefined();
    expect(failed?.starting?.reason).toContain('no session signed on');
    expect(failed?.notices.map((n) => n.kind)).toEqual(['trap-start-failed', 'trap-starting']);
  });

  it('shows working, idle, and parked trap activity from one snapshot', () => {
    const now = Date.now();
    const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
    const traps = [
      { trapId: 'working', claimed: 'aaaaaaaa-0000-4000-8000-000000000000', heartbeatAt: iso(5_000) },
      { trapId: 'idle', heartbeatAt: iso(60 * 60_000) },
      { trapId: 'parked', claimed: 'bbbbbbbb-0000-4000-8000-000000000000', heartbeatAt: iso(5_000) },
    ];
    for (const [index, trap] of traps.entries()) {
      fs.writeFileSync(path.join(home, 'soaking', `${trap.trapId}.json`), JSON.stringify({
        ...trap, sessionId: `${trap.trapId}-session`, harness: 'codex', repo: 'web',
        worktree: `/tmp/${trap.trapId}`, cwd: `/tmp/${trap.trapId}`,
        signedOnAt: iso((3 - index) * 60_000), firstParkedAt: iso(50_000),
      }));
    }
    for (const [id, trapId, brief] of [
      [traps[0]!.claimed, 'working', 'Build a stable trap view'],
      [traps[2]!.claimed, 'parked', 'Wait for the review'],
    ] as const) {
      enqueue({ id: id!, repo: 'web', brief }, 'work');
      expect(claimNext('work')).toBe(id);
      fs.writeFileSync(path.join(laneDirs('work').active, id!, 'claim.json'), JSON.stringify({ by: `wt:${trapId}`, at: iso(10_000) }));
    }
    appendStatus(traps[0]!.claimed!, 'work', 'working', 'building');
    writeActivity(traps[0]!.claimed!, 'work', { at: iso(12_000), kind: 'tool', summary: 'Bash' });
    appendStatus(traps[2]!.claimed!, 'work', 'paused', 'awaiting review', undefined, { waitingOn: 'review' });
    const snap = buildGlassSnapshot();
    const byId = (id: string) => snap.traps.find((t) => t.trapId === id)!;
    expect(byId('working')).toMatchObject({ live: true, listening: true, claimed: traps[0]!.claimed });
    expect(byId('working').catches.find((c) => c.id === traps[0]!.claimed)).toMatchObject({
      brief: 'Build a stable trap view', activity: { summary: 'Bash' }, verb: 'working',
    });
    expect(byId('idle')).toMatchObject({ live: true, listening: false, catches: [] });
    expect(byId('parked')).toMatchObject({ live: true, listening: true, claimed: traps[2]!.claimed });
    expect(byId('parked').catches.find((c) => c.id === traps[2]!.claimed)).toMatchObject({
      brief: 'Wait for the review', verb: 'paused', waiting: { on: 'review' },
    });
  });

  it('serves the page, the data, and never anything but GET reads', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('server')).toMatch(/^lobstah-glass\//);
    const version = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json()) as { service: string; pid: number };
    expect(version).toEqual(expect.objectContaining({ service: 'lobstah-glass', pid: process.pid }));
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
