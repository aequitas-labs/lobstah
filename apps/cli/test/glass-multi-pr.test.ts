import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

describe('a dispatch with several PRs in the glass', () => {
  it('links each PR by number; a dispatch with one PR keeps its single PR link', async () => {
    const d = acceptanceFleet();
    const [many, one] = d.dispatches;
    const urls = [132, 133, 134].map((n) => `https://github.com/o/r/pull/${n}`);
    many!.evidence = { ...(many!.evidence ?? {}), prUrl: urls[0], prUrls: urls };
    one!.evidence = { ...(one!.evidence ?? {}), prUrl: 'https://github.com/o/r/pull/7' };
    delete one!.evidence.prUrls;
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#dispatches', prefs: { view: 'table' } });
    open.push(g);
    const row = (id: string) => g.$$('#dispatches tr.rowhead').find((tr) => (tr.textContent ?? '').trim().startsWith(id.slice(0, 8)))!;
    const links = (id: string) => [...row(id).querySelectorAll('a[target=_blank]')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links(many!.id)).toEqual(urls.map((u) => [`#${u.split('/').pop()}`, u]));
    expect(links(one!.id)).toEqual([['PR', 'https://github.com/o/r/pull/7']]);
  });
});
