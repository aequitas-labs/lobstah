import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot, GlassReview } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';

/**
 * PR, review and report cards on the shared card (components/prs.ts,
 * reviews.ts, reports.ts), and the review modal that holds what leaves the
 * review card.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function page(d: GlassFullSnapshot, hash: string, post?: () => { status: number; body: unknown }) {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view: 'cards' }, ...(post ? { post } : {}) });
  open.push(g);
  return g;
}

const click = async (g: GlassDom, el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  (el as HTMLElement).click();
  await g.settle();
};

function review(n: number, over: Partial<GlassReview> = {}): GlassReview {
  return {
    key: `review:acme/web#${n}`,
    url: `https://github.com/acme/web/pull/${n}`,
    reviewUrl: `https://app.graphite.com/github/pr/acme/web/${n}`,
    repo: 'acme/web',
    number: n,
    title: `pr ${n}`,
    author: 'dana',
    repoKey: 'web',
    requestedBy: 'maya',
    requestedAt: ago(3600_000),
    state: 'requested',
    stands: true,
    headSha: 'aaaaaaa1',
    prHeadSha: 'aaaaaaa1',
    ...over,
  };
}

describe('a PR card', () => {
  it('shows its title, then its status on a line of its own, then its repo, number, checks, trap and age with ↗ Open, and nothing more', async () => {
    const d = acceptanceFleet();
    const p = d.prs.find((x) => x.number === 41)!;
    const g = await page(d, '#prs');
    const card = g.$$('#prs .card').find((c) => text(c.querySelector('.gcontext')).includes('#41'))!;
    expect(card.className).toContain(`gcard-edge gedge-${p.badge.tone}`);
    expect(card.querySelector('.gtop .pricon')).toBeTruthy();
    expect(card.querySelector('.gtop .gword')).toBeNull();
    expect(text(card.querySelector('.gtop + .gstate .gword'))).toBe(p.badge.text.toLowerCase());
    // Its dispatches' trap: the first one a trap was addressed or claimed.
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^web #41 · 4\/4 passed · 🪤 wt:t1 · \d+\w ago$/);
    expect(card.querySelector('.gcontext .reponame svg.repoicon')).toBeTruthy();
    expect(card.querySelectorAll(':scope > .gline')).toHaveLength(3);
    // The gate moved to the modal.
    expect(text(card)).not.toContain('gate');
    // ↗ Open leaves the card alone; the card opens the PR's modal, gate and all.
    const openLink = card.querySelector('.gaction a')!;
    expect([text(openLink), openLink.getAttribute('target')]).toEqual(['↗ Open', '_blank']);
    await click(g, openLink);
    expect(g.$('#overlay')!.className).not.toBe('open');
    await click(g, card);
    expect(text(g.$('#modalbox .sub'))).toContain('gate waiting-approval');
  });
});

describe('a report card', () => {
  it('has no status word and is greyed once acked', async () => {
    const g = await page(everyAttentionFleet(), '#reports');
    const cards = g.$$('#reports .card');
    expect(cards.length).toBeGreaterThan(1);
    for (const c of cards) {
      expect(c.querySelector('.gchip, .gword, .badge')).toBeNull();
      expect(c.className).not.toContain('gcard-edge');
    }
    expect(cards.map((c) => c.className.includes('quiet'))).toEqual([true, false, false, false]);
  });
});

describe('a review card', () => {
  it('is a PR card: its title, its verdict or state on a line under it on an edge, then repo #number, trap and age, with Open draft', async () => {
    const d = {
      ...emptyFleet(),
      dispatches: acceptanceFleet().dispatches,
      reviews: [
        review(7, {
          state: 'drafted',
          verdict: 'approve',
          staged: true,
          stagedReviewUrl: 'https://github.com/acme/web/pull/7#pullrequestreview-1',
          dispatch: 'cccccccc-0000-4000-8000-000000000003',
        }),
        review(8, { state: 'drafting', stands: false }),
        review(9, { state: 'posted', stands: false }),
        review(10, { state: 'drafted', stands: false }),
      ],
    };
    const g = await page(d, '#reviews');
    const card = (n: number) => g.$(`#reviews [data-review="review:acme/web#${n}"]`)!;
    expect(card(7).className).toContain('gcard-edge gedge-bad');
    // The PR card's lines: the title and PR icon alone on line 1, the status word under it, then the gray subtitle.
    expect(card(7).querySelector('.gtop .pricon')).toBeTruthy();
    expect(card(7).querySelector('.gtop .gword')).toBeNull();
    expect(text(card(7).querySelector('.gtop + .gstate .gword'))).toBe('approve');
    expect(text(card(7).querySelector('.gcontext .gtext'))).toBe('acme/web #7 · 🪤 wt:t1 · 60m ago');
    expect(card(7).querySelector('.gcontext .reponame svg.repoicon')).toBeTruthy();
    expect(card(7).querySelectorAll(':scope > .gline')).toHaveLength(3);
    expect(text(card(8).querySelector('.gstate'))).toBe('drafting');
    expect(text(card(9).querySelector('.gstate'))).toBe('posted');
    expect(text(card(10).querySelector('.gstate'))).toBe('draft');
    // No trap has a round that ran no job.
    expect(text(card(8).querySelector('.gcontext .gtext'))).toBe('acme/web #8 · 60m ago');
    const draft = card(7).querySelector('.gaction a')!;
    expect([text(draft), draft.getAttribute('href')]).toEqual(['Open draft', 'https://github.com/acme/web/pull/7#pullrequestreview-1']);
    expect(card(8).className).toContain('gcard-edge gedge-warn');
    expect(text(card(8).querySelector('.gaction'))).toBe('↗ Open');
    expect(card(9).className).toContain('gcard-edge gedge-ok');
    expect(card(9).className).toContain('quiet');
    // Who asked, the reason and the actions are not on the card.
    expect(text(card(7))).not.toContain('maya');
    expect(card(7).querySelector('button')).toBeNull();
  });

  it('opens its modal, marked seen, with who asked, the reason, the pending review and the actions', async () => {
    const r = review(9, { state: 'stale', reason: 'the head moved', staged: true });
    const g = await page({ ...emptyFleet(), focusToken: 'tok', reviews: [r] }, '#reviews', () => ({ status: 200, body: { ok: true } }));
    await click(g, g.$('#reviews .card'));
    expect(g.opened()).toEqual([]);
    expect(g.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'review-seen', payload: { key: r.key } });
    const box = g.$('#modalbox')!;
    expect(text(box.querySelector('h3'))).toContain('acme/web#9 pr 9');
    expect(text(box.querySelector('.sub'))).toContain('the head moved');
    expect(text(box.querySelector('.rv-person'))).toContain('maya');
    expect(text(box.querySelector('.rv-staged'))).toBe('Open pending review');
    expect([...box.querySelectorAll('button')].map(text)).toEqual(['Redraft', 'Skip']);
  });
});
