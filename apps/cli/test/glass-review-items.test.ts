import { afterEach, describe, expect, it } from 'vitest';
import type { GlassReview } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, ago, emptyFleet } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const HOUR = 3600 * 1000;

function review(n: number, over: Partial<GlassReview> = {}): GlassReview {
  return {
    key: `review:acme/web#${n}`,
    url: `https://github.com/acme/web/pull/${n}`,
    reviewUrl: `https://github.com/acme/web/pull/${n}/files`,
    repo: 'acme/web',
    number: n,
    title: `pr ${n}`,
    author: 'dana',
    repoKey: 'web',
    requestedBy: 'dana',
    requestedAt: ago(HOUR),
    state: 'requested',
    stands: true,
    headSha: 'aaaaaaa1',
    prHeadSha: 'aaaaaaa1',
    ...over,
  };
}

async function reviews(list: GlassReview[]): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: list }, { now: NOW, hash: '#reviews', prefs: { view: 'cards' } });
  open.push(g);
  await g.settle();
  return g;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('the item card', () => {
  it('draws a GitHub review with the GitHub logo, the PR glyph, its chips and context', async () => {
    const g = await reviews([review(7)]);
    const card = g.$('#reviews [data-review="review:acme/web#7"]')!;
    expect(card.getAttribute('data-item-source')).toBe('github');
    expect(card.querySelector('.gcontext .glead .srclogo')?.getAttribute('aria-label')).toBe('GitHub');
    expect(card.querySelector('.srclogo .srctip')?.textContent).toBe('GitHub');
    expect(card.querySelector('.gicon .prstate.pr-open .pricon')).not.toBeNull();
    expect(text(card.querySelector('.gstate'))).toBe('Open● requested');
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^acme\/web · .+ ago · #7$/);
    expect(card.querySelector('.gavatar')?.getAttribute('title')).toBe('requested by: dana');
    expect(card.classList.contains('gedge-bad')).toBe(true);
    expect(card.querySelector('.gactions .gopenbtn')?.getAttribute('href')).toBe('https://github.com/acme/web/pull/7/files');
    // The review controls stay in the bar, before Open.
    expect(text(card.querySelector('.gactions'))).toContain('Review (draft)');
  });

  it('keeps a finished PR quiet, with no edge and its lifecycle chip alone', async () => {
    const g = await reviews([review(8, { state: 'merged', prState: 'MERGED', stands: false })]);
    await g.go('#reviews');
    (g.$('#reviews details[data-review-section="done"]') as unknown as HTMLDetailsElement).open = true;
    await g.settle();
    const card = g.$('#reviews [data-review="review:acme/web#8"]')!;
    expect(card.querySelector('.gicon .prstate.pr-merged')).not.toBeNull();
    expect(text(card.querySelector('.gstate'))).toBe('Merged');
    expect(card.classList.contains('gcard-edge')).toBe(false);
    expect(card.classList.contains('quiet')).toBe(true);
  });

  it('names its source on a tap of the logo without opening the review', async () => {
    const g = await reviews([review(7)]);
    const logo = g.$('#reviews [data-review="review:acme/web#7"] .srclogo') as unknown as HTMLElement;
    logo.click();
    await g.settle();
    expect(g.$('#modalbox')?.textContent ?? '').not.toContain('pr 7');
    expect(g.$('#reviews [data-review="review:acme/web#7"] .srclogo')?.classList.contains('tip')).toBe(true);
    (g.$('#reviews [data-review="review:acme/web#7"]') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.$('#modalbox')?.textContent).toContain('pr 7');
  });
});
