import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import type { TodoView } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, repoFilterFleet } from './fixtures/glass-snapshots.js';

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((page) => page.close()));
  pages = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function page(d: GlassFullSnapshot, hash = '#deck') {
  const glass = await loadGlass(GLASS_PAGE, d, { now: NOW, hash });
  pages.push(glass);
  return glass;
}

describe('shared section headings', () => {
  it('links every deck section to its list and caps decisions at the three newest', async () => {
    const snapshot = repoFilterFleet();
    snapshot.todos = [
      {
        grounds: 'home',
        groundsKey: 'fleet',
        id: 1,
        text: 'Review the new heading',
        createdAt: new Date(NOW).toISOString(),
        done: false,
        stale: false,
        overdue: false,
      },
    ] satisfies TodoView[];
    const glass = await page(snapshot);
    const decisions = glass.$('#deck .decisions')!;
    expect(text(decisions.querySelector('.section-head h2'))).toContain('Decisions');
    expect(decisions.querySelector('.section-head a')?.getAttribute('href')).toBe('#decisions');
    expect(decisions.querySelectorAll(':scope > .dlist > li')).toHaveLength(3);
    expect(text(decisions.querySelector(':scope > .deckmore'))).toBe('+2 more →');

    const heads = glass.$$('#deck .deckgrid > section .section-head a');
    expect(heads.map((a) => a.getAttribute('href'))).toEqual(['#decisions', '#dispatches', '#dispatches', '#reports', '#todos', '#traps']);
    expect(heads.map(text)).toEqual([
      expect.stringContaining('Decisions'),
      expect.stringContaining('In flight'),
      expect.stringContaining('Landed · 24h'),
      expect.stringContaining('Reports'),
      expect.stringContaining('Todos'),
      expect.stringContaining('Traps'),
    ]);

    await glass.go('#decisions');
    expect(glass.$('#page-deck')?.className).toContain('on');
    expect(glass.$$('#deck .decisions > .dlist > li')).toHaveLength(5);
    expect(text(glass.$('#deck .decisions .page-head h1'))).toContain('Decisions');
  });

  it.each([
    ['dispatches', 'Dispatches'],
    ['traps', 'Traps'],
    ['prs', 'PRs'],
    ['reviews', 'Reviews'],
    ['reports', 'Reports'],
    ['todos', 'Todos'],
    ['grants', 'Grants'],
    ['notices', 'Notices'],
  ])('starts the %s page with its sentence-case title', async (tab, title) => {
    const glass = await page(acceptanceFleet(), `#${tab}`);
    expect(text(glass.$(`#page-${tab} .page-head h1`))).toContain(title);
    expect(glass.$(`#page-${tab} .page-head h1`)?.textContent).not.toBe(title.toUpperCase());
  });

  it('puts the New trap icon action in the traps page heading', async () => {
    const glass = await page(acceptanceFleet(), '#traps');
    expect(glass.$('#page-traps .page-head button[aria-label="New trap"]')).toBeTruthy();
  });
});
