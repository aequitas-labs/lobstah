import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_TABS, tabFromHash, validShowHash } from '../src/glass-diff.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});
async function page(count = 7, hash = '#deck') {
  const d = emptyFleet();
  d.todos = Array.from({ length: count }, (_, i) => ({
    grounds: 'home', id: i + 1, text: `Task ${i + 1}`, createdAt: new Date(NOW - i * 86400000).toISOString(), done: false, stale: false,
  }));
  d.attention = [{ kind: 'question', key: 'work:q', id: 'q', lane: 'work', verb: 'needs-decision', note: 'Choose', ageSecs: 0, stateHash: 'q' }];
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash });
  pages.push(g);
  return { g, d };
}
async function click(g: GlassDom, selector: string) {
  (g.$(selector) as HTMLElement).click();
  await g.settle();
}

describe('TODO preview and page', () => {
  it.each([0, 4, 5, 6, 9])('caps %i TODOs at five and only links More when needed', async (count) => {
    const { g } = await page(count);
    expect(g.$$('#deck .todo-check')).toHaveLength(Math.min(count, 5));
    const more = g.$('#deck .todos .deckmore');
    expect(!!more).toBe(count > 5);
    if (more) {
      expect(more.textContent).toBe(`More (${count - 5})`);
      expect(more.getAttribute('href')).toBe('#todos');
      await click(g, '#deck .todos .deckmore');
      expect(g.window.location.hash).toBe('#todos');
      expect(g.$$('#todos .todo-check')).toHaveLength(count);
    }
  });

  it('deep-links to all open TODOs with ids and added dates, retaining server order', async () => {
    const { g, d } = await page(8, '#todos');
    expect(tabFromHash('#todos')).toBe('todos');
    expect(validShowHash('#todos')).toBe(true);
    expect(g.$('.tabpage.on')?.id).toBe('page-todos');
    expect(g.$$('#todos .todo-text').map((el) => el.textContent)).toEqual(d.todos!.map((t) => t.text));
    expect(g.$$('#todos time').map((el) => el.getAttribute('datetime'))).toEqual(d.todos!.map((t) => t.createdAt));
    expect(g.$('#todos')?.textContent).toContain('#8 · added');
    d.todos![0]!.done = true;
    g.serve(d);
    await g.poll();
    expect(g.$$('#todos .todo-check')).toHaveLength(7);
    expect(g.$('#todos')?.textContent).not.toContain('Task 1');
    await g.go('#deck');
    expect(g.$('#deck .todo-check')?.classList.contains('done')).toBe(true);
    expect(g.$$('#deck .todo-check')).toHaveLength(5);
  });
});

describe('the tab bar and More', () => {
  it('keeps On deck and Reviews in the bar; More lists the rest, opens with focus, navigates, restores focus and marks where you are', async () => {
    const { g } = await page();
    expect(g.$('#tabs a[data-tab="deck"] .dbadge')?.textContent).toBe('1');
    const toggle = g.$('.nav-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('More');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.classList.contains('on')).toBe(false);
    await click(g, '.nav-toggle');
    expect(g.$('.nav-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(g.$$('#more-sections a').map((a) => a.getAttribute('data-tab'))).toEqual(GLASS_TABS.filter((t) => t !== 'deck' && t !== 'reviews'));
    expect(g.document.activeElement?.getAttribute('data-tab')).toBe('dispatches');
    await click(g, '#more-sections [data-tab="todos"]');
    expect(g.window.location.hash).toBe('#todos');
    expect(g.$('#more-sections')).toBeNull();
    expect(g.document.activeElement?.classList.contains('nav-toggle')).toBe(true);
    expect(g.$('.nav-toggle')?.classList.contains('on')).toBe(true);
    await click(g, '.nav-toggle');
    expect(g.$('#more-sections a[aria-current="page"]')?.getAttribute('data-tab')).toBe('todos');
    expect(g.document.activeElement?.getAttribute('data-tab')).toBe('todos');
  });

  it('handles Escape immediately when focus first enters the menu', async () => {
    const { g } = await page();
    // The menu's first focus happens during commit, before deferred effects run.
    g.document.addEventListener('focusin', (e) => {
      if ((e.target as Element).closest?.('#more-sections'))
        setTimeout(() => g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 0);
    });
    await click(g, '.nav-toggle');
    expect(g.$('.nav-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(g.document.activeElement?.classList.contains('nav-toggle')).toBe(true);
  });

  it('closes with Escape, an outside tap, the toggle, or a hash change', async () => {
    const { g } = await page();
    for (const action of ['escape', 'outside', 'toggle', 'hash']) {
      await click(g, '.nav-toggle');
      if (action === 'escape') g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (action === 'outside') g.$('h1')!.dispatchEvent(new g.window.PointerEvent('pointerdown', { bubbles: true }));
      if (action === 'toggle') await click(g, '.nav-toggle');
      if (action === 'hash') await g.go('#traps');
      await g.settle();
      expect(g.$('.nav-toggle')?.getAttribute('aria-expanded')).toBe('false');
      expect(g.$('#more-sections')).toBeNull();
      expect(g.document.activeElement?.classList.contains('nav-toggle')).toBe(true);
    }
  });
});
