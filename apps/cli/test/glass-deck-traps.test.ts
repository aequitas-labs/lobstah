import { afterEach, expect, it } from 'vitest';
import type { GlassDispatch, GlassFullSnapshot, GlassTrap, TendAttention } from '@lobstah/core';
import { DECK_TRAPS_MAX, sectionInputs } from '../../../packages/glass-ui/src/glass-diff.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

const pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

/** Recorded human waits, lifecycle departures and progress signals, alongside healthy work. */
function fleet(): GlassFullSnapshot {
  const snapshot = emptyFleet();
  const dispatch = (id: string, extra: Partial<GlassDispatch> = {}): GlassDispatch => ({
    id,
    title: id,
    lane: 'work',
    repo: 'web',
    bucket: 'active',
    verb: 'working',
    brief: id,
    attachments: [],
    messageAttachments: [],
    inbox: [],
    log: [],
    sort: NOW,
    ...extra,
  });
  const trap = (trapId: string, extra: Partial<GlassTrap> = {}): GlassTrap => ({
    trapId,
    name: `${trapId}-crab`,
    repo: 'web',
    harness: 'codex',
    live: true,
    listening: true,
    messages: [],
    notices: [],
    catches: snapshot.dispatches.some((item) => item.id === trapId) ? [trapId] : [],
    claimed: snapshot.dispatches.some((item) => item.id === trapId) ? trapId : undefined,
    ...extra,
  });
  snapshot.dispatches = [
    dispatch('decision', { verb: 'needs-decision' }),
    dispatch('blocked', { verb: 'blocked' }),
    dispatch('permission'),
    dispatch('stalled'),
    dispatch('idleworking'),
    dispatch('person', { verb: 'paused', waiting: { on: 'person', since: new Date(NOW).toISOString(), waitedSecs: 0 } }),
    dispatch('busy'),
    dispatch('heavy', { verb: 'paused', waiting: { on: 'heavy', since: new Date(NOW).toISOString(), waitedSecs: 0 } }),
    dispatch('oldactivity', {
      activity: { at: new Date(NOW - 3600_000).toISOString(), kind: 'tool', summary: 'Long build', stale: true, ageSecs: 3600 },
    }),
  ];
  snapshot.traps = [
    trap('ghost', { live: false, rosterState: 'ghosted' }),
    trap('failed', {
      live: false,
      starting: { reservedAt: new Date(NOW).toISOString(), deadline: new Date(NOW).toISOString(), failedAt: new Date(NOW).toISOString() },
    }),
    ...snapshot.dispatches.map((item) => trap(item.id)),
    trap('free'),
    trap('stowed', { live: false, rosterState: 'stowed' }),
    trap('oldghost', { live: false, notices: [{ kind: 'trap-ghosted', at: new Date(NOW - 86400000).toISOString(), text: 'Ghosted' }] }),
  ];
  snapshot.decisions = [
    {
      key: 'decision:permission',
      dispatch: 'permission',
      permission: true,
      title: 'Allow this command?',
      detail: '',
      options: ['Allow', 'No'],
      attachments: [],
      askedBy: 'worker',
      askedAt: new Date(NOW).toISOString(),
      stateHash: 'permission',
    },
  ];
  snapshot.attention = ['stalled', 'idleworking'].map((id): TendAttention => ({
    kind: 'dispatch-progress',
    key: `progress:work:${id}`,
    stateHash: id,
    id,
    lane: 'work',
    verb: id === 'stalled' ? 'stalled' : 'idle-while-working',
    ageSecs: 300,
    quiet: true,
  }));
  snapshot.repoTraps = [{ repo: 'web', used: 10, limit: 12, free: 1, harnesses: [{ harness: 'codex', count: 10 }] }];
  return snapshot;
}
const select = (snapshot: GlassFullSnapshot) => sectionInputs(snapshot, { st: { view: 'cards' }, modal: null }, NOW);
async function open(snapshot = fleet(), hash = '#deck', view = 'cards'): Promise<GlassDom> {
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash, prefs: { view } });
  pages.push(page);
  return page;
}

it('shows only recorded attention cases, excluding healthy busy/free workers and ordinary heavy waits', () => {
  expect(
    select(fleet())
      .deck.traps.map(({ x }) => x.trapId)
      .sort(),
  ).toEqual(['blocked', 'decision', 'failed', 'ghost', 'idleworking', 'oldghost', 'permission', 'person', 'stalled']);
});

it('moves the overview to On deck while the Traps page retains grouping and closed history', async () => {
  const snapshot = fleet();
  snapshot.traps.find((trap) => trap.trapId === 'failed')!.starting!.commands = [
    { harness: 'codex', command: 'codex fixture-start-command' },
  ];
  const page = await open(snapshot);
  const section = page.$('#deck .deck-traps')!;
  expect(section.querySelector('.trap-overview')?.textContent).toContain('10/12 in use · 1 free');
  expect(section.querySelector('.section-head a')?.getAttribute('href')).toBe('#traps');
  expect(section.querySelectorAll('.card')).toHaveLength(DECK_TRAPS_MAX);
  expect(section.querySelector('.startcmds')).toBeNull();
  expect(section.querySelector('.deckmore')?.textContent).toBe('+1 more →');
  expect(section.querySelector('.deckmore')?.getAttribute('href')).toBe('#traps');
  await page.go('#traps');
  expect(page.$('#traps .trap-overview')).toBeNull();
  expect(page.$('#traps .startcmds')?.textContent).toContain('fixture-start-command');
  expect(page.$('#traps [aria-label="Group traps by"]')).not.toBeNull();
  expect((page.$('#traps .trap-inactive') as HTMLDetailsElement).open).toBe(false);
});

for (const view of ['cards', 'table'])
  it(`${view}: a trap link opens its details, including from a fresh deep link`, async () => {
    const page = await open(fleet(), '#deck', view);
    const link = page.$('#deck .deck-traps a[href="#trap/blocked"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    await page.go(link.getAttribute('href')!);
    expect(page.$('#overlay')?.classList.contains('open')).toBe(true);
    expect(page.$('#modalbox')?.textContent).toContain('blocked-crab');
    const fresh = await open(fleet(), '#trap/blocked', view);
    expect(fresh.$('#modalbox')?.textContent).toContain('blocked-crab');
    (fresh.$('#overlay button[aria-label="Close"]') as HTMLButtonElement).click();
    await fresh.settle();
    expect(fresh.$('#overlay')?.classList.contains('open')).toBe(false);
    (fresh.$('#deck .deck-traps a[href="#trap/blocked"]') as HTMLAnchorElement).click();
    await fresh.settle();
    expect(fresh.$('#overlay')?.classList.contains('open')).toBe(true);
    (fresh.$('#overlay button[aria-label="Close"]') as HTMLButtonElement).click();
    await fresh.settle();
    expect(fresh.$('#overlay')?.classList.contains('open')).toBe(false);
  });

it('removes recovered attention cases on a live update and keeps the fleet overview', async () => {
  const snapshot = fleet();
  const page = await open(snapshot);
  snapshot.traps = snapshot.traps.filter((trap) => !['ghost', 'oldghost', 'failed'].includes(trap.trapId));
  snapshot.dispatches = snapshot.dispatches.map((dispatch) => ({ ...dispatch, verb: 'working', waiting: undefined }));
  snapshot.decisions = [];
  snapshot.attention = [];
  page.serve(snapshot);
  await page.poll();
  expect(page.$('#deck .deck-traps')?.textContent).toContain('No traps need attention');
  expect(page.$('#deck .deck-traps .trap-overview')).not.toBeNull();
  expect(page.$$('#deck .deck-traps .card')).toHaveLength(0);
});

it('does not mistake an older ghost notice for the current stowed or live roster state', () => {
  const snapshot = fleet();
  const oldghost = snapshot.traps.find((trap) => trap.trapId === 'oldghost')!;
  oldghost.rosterState = 'stowed';
  expect(select(snapshot).deck.traps.some(({ x }) => x.trapId === oldghost.trapId)).toBe(false);
  oldghost.rosterState = 'live';
  oldghost.live = true;
  expect(select(snapshot).deck.traps.some(({ x }) => x.trapId === oldghost.trapId)).toBe(false);
});

it('drops stale waits once their dispatch is no longer active', () => {
  const snapshot = fleet();
  snapshot.dispatches = snapshot.dispatches.map((dispatch) => ({ ...dispatch, bucket: 'done' }));
  expect(
    select(snapshot)
      .deck.traps.map(({ x }) => x.trapId)
      .sort(),
  ).toEqual(['failed', 'ghost', 'oldghost']);
});
