import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { missingCatch, trapView } from '../src/glass-diff.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';

/**
 * /data names each trap's catches by dispatch id instead of sending a copy of
 * each dispatch; the page resolves the ids against `dispatches`.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});
const page = async (d: GlassSnapshot, opts: { hash?: string; prefs?: Record<string, unknown> } = {}) => {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const click = async (g: GlassDom, el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  (el as HTMLElement).click();
  await g.settle();
};

describe('trap catches by id', () => {
  for (const view of ['table', 'cards']) {
    it(`shows each trap's catches in ${view}, including signed-off traps and the cap; the header shows today's`, async () => {
      const d = acceptanceFleet();
      d.stats = { catchesToday: 7, totalCatches: 1012 };
      d.traps[0]!.totalCatches = 12;
      d.traps[1]!.totalCatches = 1000;
      d.traps[1]!.live = false;
      const g = await page(d, { hash: '#traps', prefs: { view } });
      expect(text(g.$('#traps'))).toContain('🦞 12');
      expect(text(g.$('#traps'))).toContain('🦞 999+');
      const chip = g.$$('#chips .chip').find((c) => text(c).includes('🦞'))!;
      expect(text(chip)).toBe('🦞 7 today');
      expect(text(g.$('#traps'))).not.toMatch(/keeper|\d+ catch/);
      await g.go('#deck');
      expect(text(g.$('#deck'))).toContain('🦞 12');
      expect(text(g.$('#deck'))).toContain('🦞 999+');
    });
  }

  it('trapView resolves each id to its dispatch, in the order sent', () => {
    const d = acceptanceFleet();
    const ids = d.dispatches.slice(0, 3).map((x) => x.id).reverse();
    const view = trapView(d, { ...d.traps[0]!, catches: ids });
    expect(view.catches.map((c) => c.id)).toEqual(ids);
    expect(view.catches[0]).toBe(d.dispatches.find((x) => x.id === ids[0]));
    // The snapshot's own trap is untouched.
    expect(d.traps[0]!.catches.every((c) => typeof c === 'string')).toBe(true);
  });

  it('a catch id with no dispatch resolves to its id with an unknown state', () => {
    const d = acceptanceFleet();
    const view = trapView(d, { ...d.traps[0]!, catches: ['feedface-0000-4000-8000-000000000000'] });
    expect(view.catches).toEqual([missingCatch('feedface-0000-4000-8000-000000000000')]);
    expect(view.catches[0]).toMatchObject({ id: 'feedface-0000-4000-8000-000000000000', verb: 'unknown', title: '' });
  });

  it('the trap modal lists a missing catch; the card shows the trap\'s catch total', async () => {
    const d = acceptanceFleet();
    const t = d.traps.find((x) => x.trapId === 't1')!;
    const known = t.catches[0]!;
    t.catches = [known, 'feedface-0000-4000-8000-000000000000'];
    t.totalCatches = 1;
    const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
    const card = g.$$('#traps .card').find((c) => text(c.querySelector('b')).includes('wt:t1'))!;
    expect(text(card.querySelector('.foot'))).toContain('🦞 1');
    await click(g, card);
    const catches = g.$$('#modalbox .catch').map((c) => text(c.querySelector('.hdr')));
    expect(catches).toHaveLength(2);
    expect(catches[0]).toContain(known.slice(0, 8));
    expect(catches[1]).toContain('feedface');
    expect(catches[1]).toContain('unknown');
  });

  it('a working trap reads its current catch from dispatches on the deck and the Traps tab', async () => {
    const d = acceptanceFleet();
    const t = d.traps.find((x) => x.trapId === 't1')!;
    const current = d.dispatches.find((x) => x.id === t.catches[0])!;
    current.bucket = 'active';
    current.verb = 'working';
    t.claimed = current.id;
    t.live = true;
    const g = await page(d, { hash: '#traps' });
    const row = g.$$('#traps tr.rowhead').find((r) => text(r).includes('wt:t1'))!;
    expect(text(row)).toContain(`working · ${current.id.slice(0, 8)}`);
    await g.go('#deck');
    expect(text(g.$('#deck'))).toContain(`working · ${current.id.slice(0, 8)}`);
  });
});
