import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago } from './fixtures/glass-snapshots.js';

/**
 * The phone's header and bottom bar (components/header.ts): the helm pill,
 * the strip of the fleet's numbers, and On deck, Reviews, Search and Menu.
 * glass.css shows them under 700px and hides them wider; these tests pin
 * what they hold and do.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function fleet(): GlassFullSnapshot {
  const d = acceptanceFleet();
  d.slots = { headless: 2, limit: 4, traps: 3, parked: 0 };
  d.heavy = { running: 1, slots: 2, waiting: 1, tickets: [{ id: 'h1', command: 'pnpm test', trap: 't1', startedAt: ago(60_000) }] } as GlassFullSnapshot['heavy'];
  d.stats = { catchesToday: 4, totalCatches: 40 } as GlassFullSnapshot['stats'];
  return d;
}

async function page(d: GlassFullSnapshot = fleet(), hash = '#deck') {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, post: () => ({ status: 200, body: { ok: true } }) });
  open.push(g);
  return g;
}

const bar = (g: GlassDom) => g.$('.bottombar')!;
// A tab by its label; Search and Menu, which show only an icon, by their accessible name.
const item = (g: GlassDom, label: string) =>
  [...bar(g).querySelectorAll('.bbitem')].find((b) => text(b.querySelector('.bblabel')) === label || b.getAttribute('aria-label') === label) as HTMLElement;

describe('the phone header', () => {
  it("shows the helm as a pill, then one strip of today's catches, traps, slots and the heavy line", async () => {
    const g = await page();
    expect(text(g.$('.phone-helm .helmpill'))).toContain('claude @ web');
    expect(g.$('.phone-helm .hdot')!.className).toBe('hdot ok');
    expect(text(g.$('.phone-strip'))).toBe('🦞 4 · 🪤 3 traps · 2 of 4 · ⛰️ 1/2 +1');
    (g.$('.helmpill') as HTMLElement).click();
    await g.settle();
    expect(text(g.$('#modalbox'))).toContain('fleet');
  });

  it('turns the dot amber when the helm is stale', async () => {
    const d = fleet();
    d.helms[0]!.heartbeatAt = ago(3_600_000);
    const g = await page(d);
    expect(g.$('.phone-helm .hdot')!.className).toBe('hdot warn');
  });
});

describe('the bottom bar', () => {
  it('holds On deck, Reviews and PRs with their labels, then Search and Menu as named icons', async () => {
    const g = await page();
    expect([...bar(g).querySelectorAll('.bbitem .bblabel')].map(text)).toEqual(['On deck', 'Reviews', 'PRs']);
    expect([...bar(g).querySelectorAll('.bbitem.bbiconly')].map((b) => [b.getAttribute('aria-label'), text(b)])).toEqual([
      ['Search', ''],
      ['Menu', ''],
    ]);
    expect(item(g, 'On deck').getAttribute('href')).toBe('#deck');
    expect(item(g, 'On deck').getAttribute('aria-current')).toBe('page');
    expect(item(g, 'PRs').getAttribute('href')).toBe('#prs');
  });

  it("counts the person's own PRs that need them on PRs", async () => {
    const d = fleet();
    const failing = { ...d.prs[0]!, key: 'pr:acme/web#77', number: 77, mine: true, state: 'OPEN', badge: { ...d.prs[0]!.badge, tone: 'bad' as const } };
    d.prs = [failing, { ...failing, key: 'pr:acme/web#78', number: 78, mine: false }];
    const g = await page(d);
    expect(text(item(g, 'PRs').querySelector('.dbadge'))).toBe('1');
  });

  it('Search becomes a focused search box with the repo chips above it; ✕ puts the bar back', async () => {
    const g = await page();
    item(g, 'Search').click();
    await g.settle();
    const input = bar(g).querySelector('input[type="search"]') as HTMLInputElement;
    expect(g.document.activeElement).toBe(input);
    const chips = [...bar(g).querySelectorAll('.repochips .repochip')];
    expect(chips.map(text)[0]).toBe('all repos');
    expect(chips.map(text)).toContain('web');
    // A chip filters by repo; typing searches.
    (chips.find((c) => text(c) === 'web') as HTMLElement).click();
    await g.settle();
    expect((g.$('#f-repo') as HTMLSelectElement).value).toBe('web');
    input.value = 'cccc';
    input.dispatchEvent(new g.window.Event('input', { bubbles: true }));
    await g.settle();
    expect((g.$('#f-q') as HTMLInputElement).value).toBe('cccc');
    (bar(g).querySelector('.bbclose') as HTMLElement).click();
    await g.settle();
    expect(bar(g).querySelector('input')).toBeNull();
    // The search stays, and Search says so.
    expect(item(g, 'Search').className).toContain('on');
  });

  it('Menu lists every view with its icon, then the fleet, then Settings; Escape closes it', async () => {
    const g = await page();
    item(g, 'Menu').click();
    await g.settle();
    const menu = g.$('#phone-menu')!;
    const views = [...menu.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
    expect(views).toEqual(g.$$('#tabs a').map((a) => a.getAttribute('href')));
    // Each view's icon is the tab bar's: one mapping, the same on a phone and a desktop.
    const icons = (links: Element[]) => links.map((a) => a.querySelector('svg.navicon')?.innerHTML);
    expect(icons([...menu.querySelectorAll('nav a')])).toEqual(icons(g.$$('#tabs a')));
    expect(icons([...menu.querySelectorAll('nav a')]).every(Boolean)).toBe(true);
    expect(text(menu)).toContain('daemon');
    const settings = [...menu.querySelectorAll('button')].find((b) => text(b) === 'Settings')!;
    expect(settings.querySelector('svg.navicon')?.innerHTML).toBe(g.$('#gearbtn svg.navicon')?.innerHTML);
    (settings as HTMLElement).click();
    await g.settle();
    expect(g.$('.settings-dialog')).not.toBeNull();
    expect(g.$('#phone-menu')).toBeNull();
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await g.settle();
    item(g, 'Menu').click();
    await g.settle();
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await g.settle();
    expect(g.$('#phone-menu')).toBeNull();
  });

  it('hides while a decision card is open: the card takes the bottom edge', async () => {
    const g = await page();
    expect(bar(g)).toBeTruthy();
    (g.$('#deck .drow .dopen') as HTMLElement).click();
    await g.settle();
    expect(g.$('.dmodal')).toBeTruthy();
    expect(g.$('.bottombar')).toBeNull();
  });
});
