import * as fs from 'node:fs';
import { expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { FIXTURES, NOW } from './fixtures/glass-snapshots.js';

it('keeps the emoji brand in header/footer and the embedded pet sprite and star only on the crawler', async () => {
  // This fixture has no asset server: both pieces must travel in the page.
  const g = await loadGlass(GLASS_PAGE, FIXTURES.empty!(), { now: NOW, search: '?lob' });
  const embedded = (name: string) => 'data:image/png;base64,' + fs.readFileSync(new URL(`../../../docs/assets/${name}`, import.meta.url)).toString('base64');
  try {
    expect(g.$('h1')?.textContent).toMatch(/^🦞✨ spyglass/);
    expect(g.$('#foot')?.textContent).toMatch(/^🦞✨ lobstah v/);
    expect(g.$('h1 .pet-art, #foot .pet-art')).toBeNull();
    expect(g.$$('#lobs .lob')).toHaveLength(1);
    expect(g.$$('.pet-art')).toHaveLength(1);
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
