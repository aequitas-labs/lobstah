import * as fs from 'node:fs';
import { expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { FIXTURES, NOW } from './fixtures/glass-snapshots.js';

it('brands and crawlers carry the actual pet sprite and star, without external asset requests or emoji fallbacks', async () => {
  // This fixture has no asset server: both pieces must travel in the page.
  const g = await loadGlass(GLASS_PAGE, FIXTURES.empty!(), { now: NOW, search: '?lob' });
  const embedded = (name: string) => 'data:image/png;base64,' + fs.readFileSync(new URL(`../../../docs/assets/${name}`, import.meta.url)).toString('base64');
  try {
    expect(g.$$('.brand-pet')).toHaveLength(2);
    expect(g.$$('#lobs .lob')).toHaveLength(1);
    expect(g.$$('.pet-art')).toHaveLength(3);
    for (const art of g.$$('.pet-art')) {
      expect(art.querySelector('.sprite')?.getAttribute('style')).toContain(embedded('lob-sprite.png'));
      expect(art.querySelector('.star')?.getAttribute('src')).toBe(embedded('star.png'));
      expect(art.textContent).not.toContain('🦞');
    }
    expect(g.$('.fallback')).toBeNull();
    const walker = g.$('#lobs .lob');
    await g.poll();
    expect(g.$('#lobs .lob')).toBe(walker);
    expect(g.$$('#lobs .star')).toHaveLength(1);
  } finally {
    await g.close();
  }
});
