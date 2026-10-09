import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, appendWatchEvents, ensureLayout, listWatches, parsePrRef, prEvidence, readPrs, syncStackReadiness, upsertPr } from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { discoverPrStack } from '../src/pr-stack-watch.js';
import { observePr } from '../src/pr-watch.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { buildDigest, renderDigest } from '../src/digest.js';
import { deriveGlassPrs } from '../src/glass-prs.js';
import { lobItems } from '../src/glass-lobs.js';
import { loadGlass } from './glass-dom.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { emptyFleet } from './fixtures/glass-snapshots.js';
import { ackItemExists, writeAck } from '../src/acks.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
const now = Date.parse('2026-10-07T12:00:00Z');
const view = (n: number, over: Partial<GhPrView> = {}) => ({
  number: n, url: `https://github.com/acme/web/pull/${n}`,
  state: 'OPEN', isDraft: false, isCrossRepository: false,
  headRefOid: `sha-${n}`, headRefName: `b${n}`, baseRefName: n === 1 ? 'main' : `b${n - 1}`,
  mergeStateStatus: 'CLEAN', reviewDecision: '',
  statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...over,
});
const put = (n: number, over: Partial<GhPrView> = {}) => upsertPr(prEvidence(parsePrRef(view(n).url)!, view(n, over), new Date(now).toISOString()));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stack-cli-')); process.env.LOBSTAH_HOME = home;
  ensureLayout(); fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });
describe('stack watch discovery and shared presentation', () => {
  it.each([1, 2, 3])('watching any member #%i discovers both directions, one fetch per unknown link', (start) => {
    put(start);
    const fetch = vi.fn((_ref, branch, direction) => [1, 2, 3].map((n) => view(n)).filter((v) =>
      (direction === 'head' ? v.headRefName : v.baseRefName) === branch));
    discoverPrStack(parsePrRef(view(start).url)!, { now, fetch });
    expect(readPrs().map((p) => p.number).sort()).toEqual([1, 2, 3]);
    expect(listWatches()).toHaveLength(3);
    const calls = fetch.mock.calls.map(([, branch, direction]) => `${direction}:${branch}`);
    expect(new Set(calls).size).toBe(calls.length);
    discoverPrStack(parsePrRef(view(start).url)!, { now: now + 1000, fetch });
    expect(fetch).toHaveBeenCalledTimes(calls.length);
  });
  it('ignores fork links and incomplete lookups, retries at the existing cadence', () => {
    put(2);
    const fetch = vi.fn(() => [view(1, { isCrossRepository: true })]);
    discoverPrStack(parsePrRef(view(2).url)!, { now, fetch, everySecs: 45 });
    expect(readPrs()).toHaveLength(1); expect(listWatches()).toEqual([]);
    const calls = fetch.mock.calls.length;
    discoverPrStack(parsePrRef(view(2).url)!, { now: now + 44000, fetch, everySecs: 45 });
    expect(fetch).toHaveBeenCalledTimes(calls);
    discoverPrStack(parsePrRef(view(2).url)!, { now: now + 45000, fetch, everySecs: 45 });
    expect(fetch).toHaveBeenCalledTimes(calls * 2);
  });
  it('waits for discovered members to receive their normal review-thread observation', () => {
    put(1);
    discoverPrStack(parsePrRef(view(1).url)!, { now, fetch: (_ref, branch, direction) =>
      [2, 3].map((n) => view(n)).filter((v) => (direction === 'head' ? v.headRefName : v.baseRefName) === branch) });
    expect(buildTendReport(now).stacks[0]?.readiness?.allReady).toBe(false);
    observePr(parsePrRef(view(2).url)!, view(2, { unresolvedThreads: 1 }), { now: new Date(now) });
    observePr(parsePrRef(view(3).url)!, view(3, { unresolvedThreads: 0 }), { now: new Date(now) });
    expect(buildTendReport(now).stacks[0]?.readiness).toMatchObject({ ready: 2, allReady: false });
    observePr(parsePrRef(view(2).url)!, view(2, { unresolvedThreads: 0 }), { now: new Date(now) });
    expect(buildTendReport(now).stacks[0]?.readiness?.allReady).toBe(true);
  });
  it('keeps three ready PRs visible, with only one walking stack item, and one glass group', () => {
    [1, 2, 3].forEach((n) => put(n)); syncStackReadiness(undefined, now);
    const report = buildTendReport(now);
    expect(report.attention.filter((a) => a.kind === 'pr:ready')).toHaveLength(0);
    expect(report.attention.filter((a) => a.kind === 'stack-ready')).toHaveLength(1);
    const lobs = lobItems(report.attention, { lobs: true, preview: false });
    expect(lobs).toHaveLength(1); expect(lobs[0]?.href).toBe(view(3).url);
    expect(renderTend(report)).toContain('stack ready to merge: acme/web #1 → #2 → #3');
    expect(renderDigest(buildDigest({ now }))).toContain('stack ready to merge: acme/web #1 → #2 → #3');
    const glass = deriveGlassPrs([], [], readPrs());
    expect(glass.stacks).toHaveLength(1);
    expect(glass.stacks[0]?.readiness).toMatchObject({ ready: 3, total: 3, allReady: true });
  });
  it('shows partial-ready progress in one quiet item in tend, digest and glass', () => {
    put(1); put(2); put(3, { isDraft: true });
    const report = buildTendReport(now);
    expect(report.attention).toEqual([expect.objectContaining({ kind: 'stack-ready', quiet: true })]);
    for (const text of [renderTend(report), renderDigest(buildDigest({ now }))]) {
      expect(text).toContain('stack waiting: 2 of 3 ready'); expect(text).toContain('— #3 draft');
      expect(text).not.toContain('stack ready');
    }
    expect(renderTend(report)).toContain('stack-waiting');
    expect(report.stacks[0]?.readiness?.allReady).toBe(false);
  });
  describe('a stack bubbles only when every member is ready, settled', () => {
    const putAt = (n: number, at: number, over: Partial<GhPrView> = {}) =>
      upsertPr(prEvidence(parsePrRef(view(n).url)!, view(n, over), new Date(at).toISOString()));
    // What the pet and the glass lobs walk: unacked, not quiet.
    const walking = (t: number) => buildTendReport(t).attention.filter((a) => !a.quiet && !a.acked);
    beforeEach(() => fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 600\n'));
    it('keeps a settling-only stack quiet, in plain words, then walks once it settles', () => {
      putAt(1, now); putAt(2, now - 700_000);
      syncStackReadiness(undefined, now);
      const report = buildTendReport(now);
      const item = report.attention.find((a) => a.kind === 'stack-ready')!;
      expect(item).toMatchObject({ quiet: true, stack: { ready: 1, total: 2, allReady: false } });
      expect(item.note).toBe('stack waiting: 1 of 2 ready: acme/web #1 → #2 — #1 ready, confirming for 10 more min');
      expect(walking(now)).toEqual([]);
      expect(lobItems(report.attention, { lobs: true, preview: false })).toEqual([]);
      expect(renderTend(report)).not.toMatch(/stack ready|settling/);
      expect(buildTendReport(now + 300_000).attention.find((a) => a.kind === 'stack-ready')?.note).toContain('#1 ready, confirming for 5 more min');
      expect(walking(now + 600_000)).toEqual([expect.objectContaining({ kind: 'stack-ready', note: expect.stringContaining('stack ready to merge') })]);
    });
    it('keeps a 0-of-n stack quiet while its conflicting member walks as pr:conflict', () => {
      putAt(1, now); putAt(2, now, { mergeStateStatus: 'DIRTY' });
      syncStackReadiness(undefined, now);
      const report = buildTendReport(now);
      expect(report.attention.find((a) => a.kind === 'stack-ready')).toMatchObject({
        quiet: true, note: 'stack waiting: 0 of 2 ready: acme/web #1 → #2 — #1 ready, confirming for 10 more min; #2 conflicts',
      });
      expect(walking(now)).toEqual([expect.objectContaining({ kind: 'pr:conflict', prUrl: view(2).url })]);
      expect(lobItems(report.attention, { lobs: true, preview: false })).toEqual([expect.objectContaining({ label: 'conflicts', href: view(2).url })]);
      // Settled, the stack still waits on the conflict: still no stack bubble.
      expect(walking(now + 600_000).map((a) => a.kind)).toEqual(['pr:conflict']);
    });
    it('shows a partial stack under stack-waiting, never stack-ready, in the attention list', () => {
      putAt(1, now); putAt(2, now - 700_000);
      const report = buildTendReport(now);
      const tend = renderTend(report);
      expect(tend).toContain('stack-waiting');
      expect(tend).not.toMatch(/\bstack-ready\b/);
    });
  });
  it('does not change lone PR attention or its walking item', () => {
    put(1);
    expect(buildTendReport(now).attention).toEqual([expect.objectContaining({ kind: 'pr:ready' })]);
    expect(buildTendReport(now).attention[0]?.quiet).toBeUndefined();
    expect(lobItems(buildTendReport(now).attention, { lobs: true, preview: false })).toHaveLength(1);
  });
  it('includes an externally watched stack in its configured grounds digest', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n[repos.web]\npath = "/fixture/web"\norigin = "https://github.com/acme/web.git"\n');
    [1, 2, 3].forEach((n) => put(n));
    expect(buildTendReport(now).attention.find((a) => a.kind === 'stack-ready')?.repo).toBe('web');
    expect(buildDigest({ now, repos: new Set(['web']) }).stacks).toHaveLength(1);
    expect(buildDigest({ now, repos: new Set(['elsewhere']) }).stacks).toEqual([]);
  });
  it('restores normal lone PR behavior when only one member remains', () => {
    [1, 2, 3].forEach((n) => put(n)); syncStackReadiness(undefined, now);
    put(1, { state: 'MERGED' }); put(2, { baseRefName: 'main' }); syncStackReadiness(undefined, now);
    put(2, { state: 'MERGED', baseRefName: 'main' }); put(3, { baseRefName: 'main' }); syncStackReadiness(undefined, now);
    expect(buildTendReport(now).attention).toEqual([expect.objectContaining({ kind: 'pr:ready' })]);
    put(3, { baseRefName: 'main', headRefOid: 'new-head' }); syncStackReadiness(undefined, now);
    expect(lobItems(buildTendReport(now).attention, { lobs: true, preview: false })).toHaveLength(1);
  });
  it('folds member ready/watch items into the stack; a member problem walks as its own kind', () => {
    [1, 2, 3].forEach((n) => { put(n); addWatch(`pr:acme/web#${n}`, 'fixture', { owner: n === 1 ? 'dispatch:fixture' : 'man' }); });
    appendWatchEvents('pr:acme/web#2', [{ seq: 1, at: new Date(now).toISOString(), summary: 'ci failed' }]);
    syncStackReadiness(undefined, now);
    expect(buildTendReport(now).attention).toHaveLength(1);
    put(2, { statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] });
    const report = buildTendReport(now);
    const stack = report.attention.find((a) => a.kind === 'stack-ready')!;
    expect(stack).toMatchObject({ quiet: true, note: expect.stringContaining('stack waiting: 2 of 3 ready') });
    expect(stack.stack?.members[1]).toMatchObject({ kinds: ['pr:checks'], note: expect.stringContaining('failed') });
    expect(report.attention.filter((a) => a.kind === 'pr:checks')).toEqual([expect.objectContaining({ prUrl: view(2).url })]);
    expect(lobItems(report.attention, { lobs: true, preview: false })).toEqual([expect.objectContaining({ href: view(2).url })]);
    put(2, { statusCheckRollup: [{ name: 'Approval Gate', status: 'COMPLETED', conclusion: 'FAILURE' }] });
    expect(buildTendReport(now).attention).toEqual([expect.objectContaining({ kind: 'stack-ready', quiet: true })]);
  });
  it('links the current top everywhere, including after that top merges', () => {
    [1, 2, 3].forEach((n) => put(n)); syncStackReadiness(undefined, now);
    expect(buildTendReport(now).attention[0]!.prUrl).toBe(view(3).url);
    put(3, { state: 'MERGED' }); syncStackReadiness(undefined, now);
    const report = buildTendReport(now);
    expect(report.attention[0]!.prUrl).toBe(view(2).url);
    expect(lobItems(report.attention, { lobs: true, preview: false })[0]?.href).toBe(view(2).url);
    expect(report.stacks[0]!.readiness!.url).toBe(view(2).url);
    expect(report.notices.find((n) => n.kind === 'stack-ready')?.url).toBe(view(2).url);
    expect(renderDigest(buildDigest({ now }))).toContain(view(2).url);
  });
  it('keeps the item and acknowledgement through a bottom merge and retarget', () => {
    [1, 2, 3].forEach((n) => put(n)); syncStackReadiness(undefined, now);
    const item = buildTendReport(now).attention[0]!;
    writeAck({ key: item.key, kind: item.kind, stateHash: item.stateHash, at: new Date(now).toISOString(), by: 'pet' });
    put(1, { state: 'MERGED' }); put(2, { baseRefName: 'main' }); syncStackReadiness(undefined, now);
    const remaining = buildTendReport(now).attention[0]!;
    expect(remaining).toMatchObject({ key: item.key, stateHash: item.stateHash, acked: { by: 'pet' } });
    expect(ackItemExists(item.key)).toBe(true);
    expect(lobItems([remaining], { lobs: true, preview: false })).toEqual([]);
  });
  it.each(['rows', 'cards'])('uses the unchanged glass %s rendering with one stack state and one top-linked crawler', async (viewMode) => {
    [1, 2, 3].forEach((n) => put(n)); syncStackReadiness(undefined, now);
    const report = buildTendReport(now);
    const d = { ...emptyFleet(), ...deriveGlassPrs([], [], readPrs()), attention: report.attention, notices: report.notices, now: new Date(now).toISOString() };
    const g = await loadGlass(GLASS_PAGE, d, { now, prefs: { view: viewMode } });
    try {
      expect(g.$$('details.deckstack')).toHaveLength(0);
      const stackRows = g.$$('.deckgrid .deckline, .deckgrid .deckstack')
        .filter((el) => el.textContent?.includes('stack ready to merge: acme/web #1 → #2 → #3'));
      expect(stackRows).toHaveLength(1);
      expect(g.$$('.lob')).toHaveLength(1);
      expect(g.$('.lob')?.getAttribute('href')).toBe(view(3).url);
      await g.go('#notices');
      expect(g.$$('#notices tbody tr').filter((el) => el.textContent?.includes('stack ready to merge:'))).toHaveLength(1);
    } finally { await g.close(); }
  });
  it('renders the shared readiness once in its existing PR group', async () => {
    put(1); put(2); put(3, { isDraft: true });
    const d = { ...emptyFleet(), ...deriveGlassPrs([], [], readPrs()), now: new Date(now).toISOString() };
    const g = await loadGlass(GLASS_PAGE, d, { now, hash: '#prs' });
    try {
      expect(g.$('#prs')?.textContent).toContain('stack waiting: 2 of 3 ready');
      expect(g.$('#prs')?.textContent).toContain('— #3 draft');
      expect(g.$$('#prs tr:not(.rowhead) th').filter((th) => th.textContent?.includes('stack waiting: 2 of 3 ready'))).toHaveLength(1);
    } finally { await g.close(); }
  });
  it('does not group fork PRs with their apparent base branch in the glass', () => {
    put(1); put(2, { isCrossRepository: true });
    const glass = deriveGlassPrs([], [], readPrs());
    expect(glass.stacks).toHaveLength(2);
    expect(glass.stacks.every((s) => !s.readiness)).toBe(true);
  });
});
