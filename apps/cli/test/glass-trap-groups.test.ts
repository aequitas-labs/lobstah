import { afterEach, expect, it } from 'vitest';
import type { GlassFullSnapshot, GlassTrap } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom, type GlassDomOptions } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

const pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

/** Mixed current and departed traps exercise the page's real grouping controls. */
function fleet(): GlassFullSnapshot {
  const trap = (trapId: string, repo: string, harness: string, extra: Partial<GlassTrap> = {}): GlassTrap => ({
    trapId,
    name: `${trapId}-crab`,
    repo,
    harness,
    live: true,
    listening: true,
    heartbeatAt: new Date(NOW).toISOString(),
    messages: [],
    notices: [],
    catches: [],
    ...extra,
  });
  const snapshot = emptyFleet();
  snapshot.traps = [
    trap('alpha', 'web', 'codex'),
    trap('bravo', 'web', 'claude', { claimed: 'work', catches: ['work'] }),
    trap('charlie', 'api', 'codex'),
    trap('delta', 'web', 'claude', { live: false }),
    trap('echo', 'api', 'codex', { live: false }),
    trap('foxtrot', 'web', 'codex', {
      live: false,
      starting: { reservedAt: new Date(NOW).toISOString(), deadline: new Date(NOW).toISOString(), failedAt: new Date(NOW).toISOString() },
    }),
    trap('golf', 'api', 'claude', {
      live: false,
      starting: { reservedAt: new Date(NOW).toISOString(), deadline: new Date(NOW + 60000).toISOString() },
    }),
    trap('hotel', 'web', 'codex', { live: false, requested: { at: new Date(NOW).toISOString() } }),
  ];
  snapshot.dispatches = [
    {
      id: 'work',
      lane: 'work',
      repo: 'web',
      bucket: 'active',
      verb: 'working',
      note: 'Check the migration',
      brief: 'Check the migration',
      attachments: [],
      messageAttachments: [],
      log: [],
      inbox: [],
      sort: NOW,
    },
  ];
  snapshot.repoTraps = [
    {
      repo: 'web',
      used: 3,
      limit: 10,
      free: 1,
      harnesses: [
        { harness: 'codex', count: 2 },
        { harness: 'claude', count: 1 },
      ],
    },
    {
      repo: 'api',
      used: 2,
      free: 1,
      harnesses: [
        { harness: 'codex', count: 1 },
        { harness: 'claude', count: 1 },
      ],
    },
    { repo: 'empty', used: 0, limit: 4, free: 0, harnesses: [] },
  ];
  return snapshot;
}

async function open(options: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const page = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, hash: '#traps', prefs: { view: 'cards' }, ...options });
  pages.push(page);
  return page;
}
const groups = (page: GlassDom, parent = '#traps') =>
  page.$$(`${parent} > .trap-group`).map((group) => [group.getAttribute('data-group'), group.querySelectorAll('.card, tr.rowhead').length]);
async function choose(page: GlassDom, label: string): Promise<void> {
  (page.$$('#traps .seg button').find((button) => button.textContent === label) as HTMLButtonElement).click();
  await page.settle();
}

it('groups current traps by repo by default, then by harness or status, with each group count', async () => {
  const page = await open();
  expect(groups(page)).toEqual([
    ['api', 2],
    ['web', 3],
  ]);
  expect(page.$('#traps > .trap-group h3')?.textContent).toContain('(2)');
  await choose(page, 'Harness');
  expect(groups(page)).toEqual([
    ['claude', 2],
    ['codex', 3],
  ]);
  expect(page.$('#traps > .trap-group .harness-icon')?.getAttribute('aria-label')).toBe('Claude');
  await choose(page, 'Status');
  expect(groups(page)).toEqual([
    ['idle', 2],
    ['requested', 1],
    ['starting', 1],
    ['working', 1],
  ]);
});

it('keeps stowed, ghosted and failed starts in a closed section, grouped by the same choice', async () => {
  const page = await open();
  const history = page.$('.trap-inactive') as HTMLDetailsElement;
  expect(history.open).toBe(false);
  expect(history.querySelector('summary')?.textContent).toBe('Stowed and ghosted (3)');
  expect(groups(page, '.trap-inactive')).toEqual([
    ['api', 1],
    ['web', 2],
  ]);
  history.open = true;
  await choose(page, 'Status');
  expect(history.open).toBe(true);
  expect(groups(page, '.trap-inactive')).toEqual([
    ['signed off', 2],
    ['start failed', 1],
  ]);
});

it('persists the selected grouping and restores it on a fresh page', async () => {
  const page = await open();
  await choose(page, 'Harness');
  const stored = JSON.parse(page.window.localStorage.getItem('spyglass')!);
  expect(stored.trapGroup).toBe('harness');
  const restored = await open({ prefs: stored });
  expect(groups(restored)).toEqual([
    ['claude', 2],
    ['codex', 3],
  ]);
  expect(
    restored
      .$$('#traps .seg button')
      .find((button) => button.textContent === 'Harness')
      ?.getAttribute('aria-pressed'),
  ).toBe('true');
});

it('falls back for an invalid stored choice and still works when storage is unavailable', async () => {
  const invalid = await open({ prefs: { trapGroup: 'other' } });
  expect(groups(invalid)).toEqual([
    ['api', 2],
    ['web', 3],
  ]);
  const unavailable = await open({
    prefs: undefined,
    prepare: (window) =>
      Object.defineProperty(window, 'localStorage', {
        get: () => {
          throw new Error('Storage unavailable');
        },
      }),
  });
  await choose(unavailable, 'Status');
  expect(groups(unavailable).map(([name]) => name)).toContain('working');
});

it('shows repo capacity, available workers and the accessible harness mix, including an empty repo', async () => {
  const page = await open({ hash: '#deck' });
  const rows = page.$$('#deck .trap-overview-row');
  expect(rows[0]?.textContent).toContain('web3/10 in use · 1 free');
  expect(rows[1]?.textContent).toContain('api2 in use · 1 free');
  expect(rows[2]?.textContent).toContain('empty0/4 in use · 0 free');
  expect(rows[0]?.querySelector('[aria-label="Codex"]')?.parentElement?.textContent).toContain('2');
  expect(rows[0]?.querySelector('[aria-label="Claude"]')?.parentElement?.textContent).toContain('1');
});

it('keeps grouping and history controls on the Traps page while the overview is on deck', async () => {
  const page = await open({ hash: '#deck' });
  expect(page.$('#deck .trap-overview')).not.toBeNull();
  expect(page.$('#deck .trap-inactive')).toBeNull();
  expect(page.$('#deck [aria-label="Group traps by"]')).toBeNull();
});
