import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet, ago } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});
async function page(d: GlassSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function fleet(stale: boolean): GlassSnapshot {
  const d = acceptanceFleet();
  const x = d.dispatches.find((y) => y.id.startsWith('bbbbbbbb'))!;
  x.note = 'building the parser';
  x.activity = { at: ago(stale ? 20 * 60_000 : 12_000), kind: 'tool', summary: 'Edit src/parse.ts', ageSecs: stale ? 1200 : 12, stale };
  return d;
}

describe('glass: the activity line sits under the verb and note', () => {
  for (const view of ['cards', 'table'] as const) {
    it(`${view}: fresh activity shows its summary and age`, async () => {
      const g = await page(fleet(false), { hash: '#dispatches', prefs: { view } });
      const el = g.$$('#dispatches .activity')[0];
      expect(text(el)).toBe('Edit src/parse.ts · 12s ago');
      expect(el?.className).toBe('activity');
    });
  }

  it('stale activity is dim and says so, with its age', async () => {
    const g = await page(fleet(true), { hash: '#dispatches', prefs: { view: 'cards' } });
    const card = g.$$('#dispatches .card').find((c) => text(c).includes('bbbbbbbb'))!;
    expect(text(card.querySelector('.note'))).toBe('building the parser');
    const el = card.querySelector('.activity')!;
    expect(el.className).toBe('activity stale');
    expect(text(el)).toBe('stale · Edit src/parse.ts · 20m ago');
  });
});
