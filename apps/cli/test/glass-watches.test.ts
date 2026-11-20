import { afterEach, describe, expect, it } from 'vitest';
import type { WatchInventoryRow } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, ago, emptyFleet } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const helm = { kind: 'helm' as const, id: 'home', grounds: 'home', name: 'home helm' };
const row = (over: Partial<WatchInventoryRow> & Pick<WatchInventoryRow, 'key' | 'source' | 'title'>): WatchInventoryRow => ({
  generation: 'g',
  type: over.source.id,
  status: 'watching',
  owner: helm,
  subtitle: '',
  derived: false,
  createdAt: ago(86_400_000),
  next: { state: 'scheduled', at: new Date(NOW + 33_000).toISOString() },
  health: 'healthy',
  links: [],
  ...over,
});
const github = { id: 'github', name: 'GitHub', icon: { glyph: 'github' as const } };
const ume = { id: 'ume', name: 'ume', icon: { glyph: 'ume' as const } };
const deploy = { id: 'deploy', name: 'Deployment', icon: { glyph: 'source' as const } };
/** Latest check first, as the boat sends them. */
const inventory = (): WatchInventoryRow[] => [
  row({ key: 'ume-reviews:p', source: ume, title: 'Incoming reviews', glyph: 'document', lastAttemptAt: ago(8_000) }),
  row({ key: 'review-requests:chris', source: github, title: 'lobstah #539', glyph: 'pull-request', lastAttemptAt: ago(12_000), links: [{ label: 'Open', url: 'https://github.com/a/b/pull/539' }] }),
  row({
    key: 'deploy:production',
    source: deploy,
    title: 'Production release',
    status: 'held',
    owner: { kind: 'dispatch', id: 'a7c2e91f', grounds: 'home' },
    lastAttemptAt: ago(120_000),
    next: { state: 'held' },
    health: 'held',
    error: { message: 'Access expired.', remedy: 'Reconnect, then release.', failures: 3 },
  }),
  row({ key: 'local:notices', source: { id: 'local-notices', name: 'Notices', icon: { glyph: 'source' as const } }, title: 'Notices', derived: true, next: { state: 'unknown' } }),
];

async function glass(over: Record<string, unknown> = {}, prefs: Record<string, unknown> = {}) {
  const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), watchInventory: inventory(), ...over } as never, { now: NOW, hash: '#watches', prefs: { view: 'cards', ...prefs } });
  open.push(g);
  return g;
}
const cards = (g: GlassDom) => g.$$('#watches [data-watch]').map((card) => card.getAttribute('data-watch'));

describe('the Watches page', () => {
  it('is in desktop More and the phone Menu, not pinned to the bar', async () => {
    const g = await glass();
    expect(g.$('#tabs a[data-tab="watches"]')).not.toBeNull();
    expect(g.$('.bbitem[href="#watches"]')).toBeNull();
    expect(g.$('#watches')).not.toBeNull();
  });

  it('groups by source by default, with full source names and counts, and counts only real watches as active', async () => {
    const g = await glass();
    const pressed = g.$$('#watches .watch-controls .seg button').map((button) => [button.textContent, button.getAttribute('aria-pressed')]);
    expect(pressed).toEqual([
      ['Source', 'true'],
      ['Timestamp', 'false'],
    ]);
    expect(g.$$('#watches .watch-source-head').map((head) => head.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Deployment 1', 'GitHub 1', 'Notices 1', 'ume 1']);
    expect(g.$('#page-watches .watch-count')?.textContent).toBe('3 active');
    // Cards abbreviate the source to its logo, named for screen readers.
    const card = g.$('#watches [data-watch="review-requests:chris"]')!;
    expect(card.querySelector('.glead [aria-label="GitHub"]')).not.toBeNull();
    expect(card.querySelector('.gcontext .gtext')?.textContent).toContain('home helm');
    expect(card.querySelector('.gcontext .gtext')?.textContent).not.toContain('GitHub');
    expect(card.textContent).toContain('Last check 12s ago · Next in 33s');
    expect(card.querySelector('.gopen')?.getAttribute('href')).toBe('https://github.com/a/b/pull/539');
    const held = g.$('#watches [data-watch="deploy:production"]')!;
    expect(held.textContent).toContain('Next held');
    expect(held.querySelector('.gchip')?.textContent).toBe('held');
    expect(held.querySelector('.gfoot')?.textContent).toContain('Access expired. Reconnect, then release.');
    // The owner falls back to its ID.
    expect(held.querySelector('.gcontext .gtext')?.textContent).toContain('a7c2e91f');
    expect(g.$('#watches [data-watch="local:notices"]')?.textContent).toContain('derived view');
  });

  it('switches to one list by latest check, remembers it, and keeps the logo on each card', async () => {
    const g = await glass();
    (g.$$('#watches .seg button').find((button) => button.textContent === 'Timestamp') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.$$('#watches .watch-source-head')).toHaveLength(0);
    expect(cards(g)).toEqual(['ume-reviews:p', 'review-requests:chris', 'deploy:production', 'local:notices']);
    expect(g.$('#watches .watch-caption')?.textContent).toBe('Latest check first');
    expect(JSON.parse(g.window.localStorage.getItem('spyglass')!).watchOrder).toBe('timestamp');
    expect(g.$('#watches [data-watch="ume-reviews:p"] .glead [aria-label="ume"]')).not.toBeNull();
    const fresh = await glass({}, { watchOrder: 'timestamp' });
    expect(fresh.$$('#watches .watch-source-head')).toHaveLength(0);
  });

  it('filters by owner and health in either order, and shows the same rows as a table', async () => {
    const g = await glass({}, { watchOwner: 'dispatch' });
    expect(cards(g)).toEqual(['deploy:production']);
    const health = await glass({}, { watchHealth: 'healthy', watchOrder: 'timestamp' });
    expect(cards(health)).toEqual(['ume-reviews:p', 'review-requests:chris', 'local:notices']);
    const table = await glass({}, { view: 'table', watchOrder: 'timestamp' });
    expect(table.$$('#watches tr[data-watch]').map((tr) => tr.getAttribute('data-watch'))).toEqual(cards(await glass({}, { watchOrder: 'timestamp' })));
    expect(table.$('#watches tr[data-watch="deploy:production"]')?.textContent).toContain('Access expired.');
  });

  it('expands a card to its exact times and identity without any lifecycle control', async () => {
    const g = await glass();
    const card = g.$('#watches [data-watch="deploy:production"]') as unknown as HTMLElement;
    card.click();
    await g.settle();
    const details = card.querySelector('.watch-details')!.textContent!;
    expect(details).toContain('deploy:production');
    expect(details).toContain('Failures in a row');
    expect(card.querySelectorAll('button').length).toBe(1);
  });

  it('says so when an older boat sends no inventory, and when nothing is watched', async () => {
    const older = await glass({ watchInventory: undefined });
    expect(older.$('#watches')?.textContent).toContain('does not list its watches yet');
    const empty = await glass({ watchInventory: [] });
    expect(empty.$('#watches')?.textContent).toContain('No watches are active');
  });
});
