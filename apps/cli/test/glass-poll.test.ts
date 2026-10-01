import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendStatus, enqueue, ensureLayout } from '@lobstah/core';
import type { GlassBeats, GlassDispatch, GlassFullSnapshot, GlassOlderPage, GlassSnapshot } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { NOTE_MAX, OLDER_PAGE, POLL_MIN, POLL_WINDOW_MS, olderPage, pollBody, pollSnapshot } from '../src/glass-poll.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, bigFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The 2s poll stays cheap however long the fleet has run: /data carries
 * dispatch summaries and a day of history, a dispatch's detail and older
 * history load on demand, and a poll where nothing a person reads changed
 * answers 304.
 */

const HEAVY = ['brief', 'log', 'inbox', 'attachments', 'messageAttachments'] as const;
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-poll-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('the /data poll of a long-lived fleet', () => {
  it('carries summaries of 300 dispatches in a tenth of the bytes', () => {
    const full = bigFleet();
    expect(full.dispatches).toHaveLength(300);
    const whole = JSON.stringify(full).length;
    const { body } = pollBody(full, NOW);
    expect(whole).toBeGreaterThan(1_500_000);
    expect(body.length).toBeLessThan(whole / 10);
    expect(body.length).toBeLessThan(150_000);
    const d = JSON.parse(body) as GlassSnapshot;
    for (const x of d.dispatches) {
      for (const k of HEAVY) expect(x, `${x.id} ${k}`).not.toHaveProperty(k);
      expect(Object.keys(x.evidence ?? {}).every((k) => ['deliveredTo', 'prUrl', 'prUrls', 'pr'].includes(k))).toBe(true);
      expect(Object.keys(x.evidence?.pr ?? {})).toEqual(x.evidence?.pr ? ['url'] : []);
      expect(x.title).toMatch(/^Task \d+: Implement/);
      expect(x.note!.length).toBeLessThanOrEqual(NOTE_MAX + 1);
      expect(x.noteCut).toBe(true);
    }
    // The row still shows its PR: the summary keeps its URL and badge.
    const done = d.dispatches.find((x) => x.bucket === 'done')!;
    expect(done.evidence).toEqual({ prUrl: expect.stringMatching(/\/pull\/\d+$/), pr: { url: expect.stringMatching(/\/pull\/\d+$/) } });
  });

  it('keeps queued and active work, a day of finished work, and at least the newest few', () => {
    const full = bigFleet();
    const d = pollSnapshot(full, NOW);
    const ids = new Set(d.dispatches.map((x) => x.id));
    for (const x of full.dispatches.filter((x) => x.bucket !== 'done')) expect(ids.has(x.id)).toBe(true);
    const recent = full.dispatches.filter((x) => x.bucket === 'done' && x.sort >= NOW - POLL_WINDOW_MS);
    expect(recent.length).toBeGreaterThan(POLL_MIN.dispatches);
    for (const x of recent) expect(ids.has(x.id)).toBe(true);
    expect(d.dispatches).toHaveLength(10 + recent.length);
    expect(d.older).toEqual({
      dispatches: 300 - d.dispatches.length,
      notices: full.notices.length - d.notices.length,
      prs: full.prs.length - d.prs.length,
    });
    // Open PRs always; merged or closed ones from the day, or the newest few; each with its stack.
    expect(d.prs.filter((p) => p.state === 'OPEN')).toHaveLength(3);
    const closed = full.prs.filter((p) => p.state !== 'OPEN');
    expect(closed.filter((p) => Date.parse(p.mergedAt ?? p.closedAt!) >= NOW - POLL_WINDOW_MS).length).toBeLessThan(POLL_MIN.prs);
    expect(d.prs.filter((p) => p.state !== 'OPEN')).toEqual(closed.slice(0, POLL_MIN.prs));
    for (const p of d.prs) expect(d.stacks.some((s) => s.id === p.stackId)).toBe(true);
    expect(d.notices.every((n) => Date.parse(n.at) >= NOW - POLL_WINDOW_MS)).toBe(true);
    expect(d.landed.every((l) => Date.parse(l.at) >= NOW - POLL_WINDOW_MS)).toBe(true);

    // A quiet week: nothing finished in the last day, and the newest few still show.
    const quiet = pollSnapshot(full, NOW + 7 * POLL_WINDOW_MS);
    expect(quiet.dispatches.filter((x) => x.bucket === 'done')).toHaveLength(POLL_MIN.dispatches);
    expect(quiet.notices).toHaveLength(POLL_MIN.notices);
    expect(quiet.prs.filter((p) => p.state !== 'OPEN')).toHaveLength(POLL_MIN.prs);
  });

  it('pages in every record it leaves out, newest first, once each', () => {
    const full = bigFleet();
    const d = pollSnapshot(full, NOW);
    for (const kind of ['dispatches', 'notices', 'prs'] as const) {
      const seen: string[] = [];
      let page: GlassOlderPage;
      do {
        page = olderPage(full, kind, seen.length, OLDER_PAGE, NOW);
        expect(page.total).toBe(d.older![kind]);
        expect(page.items.length).toBeLessThanOrEqual(OLDER_PAGE);
        if (page.kind === 'dispatches') {
          for (const x of page.items) for (const k of HEAVY) expect(x).not.toHaveProperty(k);
          seen.push(...page.items.map((x) => x.id));
        } else if (page.kind === 'notices') seen.push(...page.items.map((n) => n.seq));
        else {
          for (const p of page.items) expect(page.stacks.map((s) => s.id)).toContain(p.stackId);
          seen.push(...page.items.map((p) => p.key));
        }
      } while (page.items.length > 0);
      const inPoll = new Set<string>(
        kind === 'dispatches' ? d.dispatches.map((x) => x.id) : kind === 'notices' ? d.notices.map((n) => n.seq) : d.prs.map((p) => p.key),
      );
      const all = kind === 'dispatches' ? full.dispatches.map((x) => x.id) : kind === 'notices' ? full.notices.map((n) => n.seq) : full.prs.map((p) => p.key);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...inPoll, ...seen].sort()).toEqual([...all].sort());
      expect(all.filter((k) => !inPoll.has(k))).toEqual(seen);
    }
  });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the /data endpoints', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it('answers 304 while only heartbeats and ages tick, with the beats in a header, and 200 when anything else changes', async () => {
    let fleet: GlassFullSnapshot = bigFleet();
    server = serveGlass(0, { snapshot: () => fleet });
    const base = await listen(server);
    const first = await fetch(`${base}/data`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/".+"$/);
    const body = (await first.json()) as GlassSnapshot;
    expect(body.focusToken).toBeTruthy();

    // Heartbeats, the server time, and ages move: 304, and the header carries the new beats.
    fleet = structuredClone(fleet);
    fleet.now = new Date(NOW + 2000).toISOString();
    fleet.helms[0]!.heartbeatAt = new Date(NOW + 1000).toISOString();
    for (const a of fleet.attention) a.ageSecs += 2;
    const same = await fetch(`${base}/data`, { headers: { 'if-none-match': etag } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe('');
    const beats = JSON.parse(decodeURIComponent(same.headers.get('x-lobstah-beats')!)) as GlassBeats;
    expect(beats.now).toBe(fleet.now);
    expect(beats.helms[fleet.helms[0]!.grounds]).toBe(fleet.helms[0]!.heartbeatAt);

    // A note changes: a new body and a new ETag.
    fleet = structuredClone(fleet);
    fleet.dispatches[0]!.note = 'a new note';
    const changed = await fetch(`${base}/data`, { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(((await changed.json()) as GlassSnapshot).dispatches[0]!.note).toBe('a new note');

    // Another glass (a new page token) never matches this one's ETag.
    const other = serveGlass(0, { snapshot: () => fleet });
    try {
      const again = await fetch(`${await listen(other)}/data`, { headers: { 'if-none-match': changed.headers.get('etag')! } });
      expect(again.status).toBe(200);
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it('pages older history, and refuses an unknown kind or path', async () => {
    const fleet = bigFleet();
    server = serveGlass(0, { snapshot: () => fleet });
    const base = await listen(server);
    const poll = (await (await fetch(`${base}/data`)).json()) as GlassSnapshot;
    const page = (await (await fetch(`${base}/data/older?kind=dispatches&offset=0&limit=25`)).json()) as GlassOlderPage;
    expect(page).toMatchObject({ kind: 'dispatches', offset: 0, total: poll.older!.dispatches });
    expect(page.items).toHaveLength(25);
    expect(page.items.some((x) => poll.dispatches.some((y) => y.id === x.id))).toBe(false);
    const prs = (await (await fetch(`${base}/data/older?kind=prs`)).json()) as GlassOlderPage;
    expect(prs.kind === 'prs' && prs.stacks.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/data/older?kind=traps`)).status).toBe(400);
    expect((await fetch(`${base}/data/elsewhere`)).status).toBe(404);
    expect((await fetch(`${base}/data/dispatch/..%2F..%2Fconfig`)).status).toBe(404);
  });

  it("serves one dispatch's detail from disk: the brief, the log, and the whole note", async () => {
    const id = '0a1b2c3d-0000-4000-8000-000000000001';
    const note = 'done: '.padEnd(900, 'x');
    enqueue({ id, repo: 'web', brief: 'Slim the poll\nThe second line of the brief.' }, 'work');
    appendStatus(id, 'work', 'done', note);
    server = serveGlass(0);
    const base = await listen(server);
    const summary = ((await (await fetch(`${base}/data`)).json()) as GlassSnapshot).dispatches.find((x) => x.id === id)!;
    expect(summary).toMatchObject({ id, title: 'Slim the poll', verb: 'done', noteCut: true });
    for (const k of HEAVY) expect(summary).not.toHaveProperty(k);
    const detail = (await (await fetch(`${base}/data/dispatch/${id}`)).json()) as GlassDispatch;
    expect(detail).toMatchObject({ id, title: 'Slim the poll', brief: 'Slim the poll\nThe second line of the brief.', note });
    expect(detail.log.map((e) => e.verb)).toEqual(['done']);
    expect((await fetch(`${base}/data/dispatch/ffffffff-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});

describe('the page on a slim poll', () => {
  let g: GlassDom | undefined;
  afterEach(async () => {
    await g?.close();
    g = undefined;
  });

  it('a poll where nothing changed answers 304 and leaves every row node in place', async () => {
    const fleet = bigFleet();
    g = await loadGlass(GLASS_PAGE, fleet, { now: NOW, hash: '#dispatches' });
    const rows = g.$$('#dispatches tr.rowhead');
    expect(rows.length).toBeGreaterThan(10);
    await g.poll();
    await g.poll();
    expect(g.notModified()).toBe(2);
    expect(g.$$('#dispatches tr.rowhead')).toEqual(rows);
    // A heartbeat that ticks shows without a new body.
    const helm = structuredClone(fleet);
    helm.helms[0]!.heartbeatAt = new Date(NOW - 5_000).toISOString();
    g.serve(helm);
    await g.poll();
    expect(g.notModified()).toBe(3);
    expect(g.$('#chips [data-age]')?.getAttribute('data-age')).toBe(helm.helms[0]!.heartbeatAt);
  });

  it('a dispatch modal shows the summary, then its brief and log from the detail', async () => {
    const fleet = bigFleet();
    const x = fleet.dispatches.find((d) => d.bucket === 'done')!;
    g = await loadGlass(GLASS_PAGE, fleet, { now: NOW, hash: '#dispatches' });
    (g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes(x.id.slice(0, 8))) as HTMLElement).click();
    await g.settle();
    expect(g.dataFetches()).toEqual([`/data/dispatch/${x.id}`]);
    expect(text(g.$('#modalbox pre'))).toBe(x.brief);
    expect(text(g.$('#modalbox'))).toContain(x.log[0]!.note!);
    expect(text(g.$('#modalbox'))).toContain(JSON.stringify(x.evidence));
  });

  it('show older pages in the dispatches the poll left out', async () => {
    const fleet = bigFleet();
    g = await loadGlass(GLASS_PAGE, fleet, { now: NOW, hash: '#dispatches' });
    const before = g.$$('#dispatches tr.rowhead').length;
    const left = pollSnapshot(fleet, NOW).older!.dispatches;
    const button = g.$('#dispatches .older button') as HTMLElement;
    expect(text(button)).toBe(`show 50 older (of ${left})`);
    button.click();
    await g.settle();
    expect(g.dataFetches()).toEqual(['/data/older?kind=dispatches&offset=0&limit=50']);
    expect(g.$$('#dispatches tr.rowhead')).toHaveLength(before + 50);
    expect(text(g.$('#dispatches .older button'))).toBe(`show 50 older (of ${left - 50})`);
    // The paged-in rows stay through later polls.
    await g.poll();
    expect(g.$$('#dispatches tr.rowhead')).toHaveLength(before + 50);
  });
});
