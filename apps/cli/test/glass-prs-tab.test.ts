import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';

/**
 * The PRs tab leads with Yours: the stacks holding one of the person's own
 * PRs (GlassPr.mine). Every other watched PR sits under Other PRs, closed
 * until opened. Reviews stays its own tab.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});
async function page(d: GlassFullSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The acceptance fleet's three-PR stack, plus one more PR in its own stack; `mine` marks which are the person's. */
function fleet(mine: number[]): GlassFullSnapshot {
  const d = acceptanceFleet();
  const lone = { ...d.prs[0]!, key: 'pr:acme/web#50', url: 'https://github.com/acme/web/pull/50', number: 50, title: 'A lone PR', stackId: 'pr:acme/web#50', position: 0 };
  d.prs = [...d.prs, lone].map((p) => ({ ...p, mine: mine.includes(p.number) }));
  d.stacks = [...d.stacks, { id: 'pr:acme/web#50', floor: 'main', repo: d.stacks[0]!.repo, numbers: [50], open: true, nextNumber: 50, behind: 0 }];
  return d;
}

for (const view of ['cards', 'table'] as const) {
  describe(`the PRs tab, as ${view}`, () => {
    it("leads with Yours, counting the person's PRs, and puts every other PR under Other PRs, closed", async () => {
      const g = await page(fleet([50]), { hash: '#prs', prefs: { view } });
      expect(text(g.$('#prs .yourshead'))).toBe('Yours · 1');
      const others = g.$('#prs details.otherprs')!;
      expect(text(others.querySelector('summary'))).toBe('Other PRs · 3');
      expect(others.hasAttribute('open')).toBe(false);
      // Yours comes before Other PRs, and holds only the lone PR's stack.
      const yoursPart = text(g.$('#prs')).split('Other PRs')[0]!;
      expect(yoursPart).toContain('A lone PR');
      expect(yoursPart).not.toContain('#41');
      expect(text(others)).toContain('#41');
    });

    it('keeps a whole stack under Yours when any of its PRs is the person’s', async () => {
      const g = await page(fleet([42]), { hash: '#prs', prefs: { view } });
      const yoursPart = text(g.$('#prs')).split('Other PRs')[0]!;
      for (const n of ['#41', '#42', '#43']) expect(yoursPart).toContain(n);
      expect(text(g.$('#prs .yourshead'))).toBe('Yours · 1');
    });

    it('says how a PR gets into Yours when none of the watched PRs is the person’s', async () => {
      const g = await page(fleet([]), { hash: '#prs', prefs: { view } });
      expect(text(g.$('#prs .yourshead'))).toBe('Yours · 0');
      expect(text(g.$('#prs'))).toContain('lobstah watch add <url>');
    });
  });
}

it('leaves Reviews its own tab', async () => {
  const g = await page(fleet([50]), { hash: '#reviews' });
  expect(g.$('#tabs a[href="#reviews"]')?.className).toContain('on');
  expect(g.$('#reviews .yourshead')).toBeNull();
});
