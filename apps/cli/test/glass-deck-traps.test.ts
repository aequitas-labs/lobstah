import { afterEach, expect, it } from 'vitest';
import type { GlassDispatch, GlassFullSnapshot, GlassTrap, TendAttention } from '@lobstah/core';
import { isActiveTrap, sectionInputs } from '../../../packages/glass-ui/src/glass-diff.js';
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
  expect(section.querySelectorAll('.trap-buoy')).toHaveLength(10);
  expect(section.querySelector('.section-count')?.textContent).toContain('10');
  expect(section.querySelector('.section-head a')?.getAttribute('href')).toBe('#traps');
  expect(section.querySelectorAll('.card, .trap-deckline')).toHaveLength(0);
  expect(section.textContent).not.toMatch(/ghost-crab|failed-crab|stowed-crab/);
  expect(section.textContent).toContain('free-crab');
  expect(section.querySelector('.harness-icon')?.getAttribute('aria-label')).toBe('Codex');
  expect(section.querySelector('.trap-buoy-harness')?.getAttribute('aria-label')).toContain('Codex');
  expect(section.querySelector('.startcmds')).toBeNull();
  expect(section.querySelector('.deckmore')).toBeNull();
  await page.go('#traps');
  expect(page.$('#traps .trap-overview')).toBeNull();
  expect(page.$('#traps .startcmds')?.textContent).toContain('fixture-start-command');
  expect(page.$('#traps [aria-label="Group traps by"]')).not.toBeNull();
  expect((page.$('#traps .trap-inactive') as HTMLDetailsElement).open).toBe(false);
});

for (const view of ['cards', 'table'])
  it(`${view}: the overview leads to the full Traps page`, async () => {
    const page = await open(fleet(), '#deck', view);
    const link = page.$('#deck .deck-traps .section-head a')!;
    await page.go(link.getAttribute('href')!);
    expect(page.$('#page-traps.on')).not.toBeNull();
    expect(page.$('#traps')?.textContent).toContain('blocked-crab');
    const fresh = await open(fleet(), '#trap/blocked', view);
    expect(fresh.$('#modalbox')?.textContent).toContain('blocked-crab');
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
  expect(page.$$('#deck .trap-buoy')).toHaveLength(10);
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


it('counts only live traps on both headings, including busy, parked and non-listening workers', async () => {
  const snapshot = fleet();
  snapshot.traps.find((trap) => trap.trapId === 'busy')!.listening = false;
  snapshot.traps.push({ ...snapshot.traps[0]!, trapId: 'starting', starting: { reservedAt: new Date(NOW).toISOString(), deadline: new Date(NOW + 60000).toISOString() } });
  expect(snapshot.traps.filter(isActiveTrap)).toHaveLength(10);
  const page = await open(snapshot);
  expect(page.$('#deck .deck-traps .section-count')?.textContent).toContain('10');
  await page.go('#traps');
  expect(page.$('#traps > .section-head .section-count')?.textContent).toContain('10');
});

it('links each buoy to its own trap page and reopens the same route after closing', async () => {
  const page = await open();
  const link = page.$('#deck .trap-buoy-art a[href="#trap/blocked"]') as HTMLAnchorElement;
  expect(link.getAttribute('aria-label')).toBe('Open blocked-crab · web');
  link.click();
  await page.settle();
  expect(page.$('#modalbox')?.textContent).toContain('blocked-crab');
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape' }));
  await page.settle();
  link.click();
  await page.settle();
  expect(page.$('#modalbox')?.textContent).toContain('blocked-crab');
});

it('shows current work by status tap or focus, the repo below the name and the model by harness focus', async () => {
  const snapshot = fleet();
  snapshot.dispatches.find((dispatch) => dispatch.id === 'busy')!.note = 'Checking the migration ' + 'details '.repeat(50);
  snapshot.traps.find((trap) => trap.trapId === 'busy')!.model = 'gpt-6.1-sol';
  const page = await open(snapshot);
  const buoy = page.$('#deck a[href="#trap/busy"]')!.closest('.trap-buoy')!;
  const status = buoy.querySelector('button') as HTMLButtonElement;
  status.click();
  await page.settle();
  expect(page.$('#modalbox')?.textContent).not.toContain('busy-crab');
  expect(buoy.querySelector('[role="tooltip"]')?.textContent).toContain('working · busy · Checking the migration');
  expect(buoy.querySelector('[role="tooltip"]')!.textContent!.length).toBeLessThan(300);
  status.focus();
  await page.settle();
  expect(buoy.querySelector('[role="tooltip"]')).not.toBeNull();
  status.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await page.settle();
  expect(buoy.querySelector('[role="tooltip"]')).toBeNull();
  (buoy.querySelector('a') as HTMLAnchorElement).focus();
  await page.settle();
  expect(buoy.querySelector('[role="tooltip"]')).toBeNull();
  expect(buoy.querySelector('.trap-buoy-repo')?.textContent).toBe('web');
  (buoy.querySelector('.worker-harness') as HTMLElement).focus();
  await page.settle();
  expect(buoy.querySelector('[role="tooltip"]')?.textContent).toBe('gpt-6.1-sol');
  expect(page.$('#deck a[href="#trap/free"]')!.closest('.trap-buoy')!.querySelector('button')?.getAttribute('aria-label')).toContain('idle');
});

it('removes departed buoys on a poll and welcomes an empty fleet', async () => {
  const snapshot = fleet();
  const page = await open(snapshot);
  snapshot.traps = snapshot.traps.map((trap) => ({ ...trap, live: false }));
  page.serve(snapshot);
  await page.poll();
  expect(page.$$('#deck .trap-buoy')).toHaveLength(0);
  expect(page.$('#deck .deck-traps .section-count')?.textContent).toContain('0');
  expect(page.$('#deck .deck-traps .empty')?.textContent).toContain('No buoys on the water');
});
