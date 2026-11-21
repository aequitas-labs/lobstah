import { afterEach, describe, expect, it } from 'vitest';
import type { GlassReview, UmeReviews } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { umeReviewRequestItem } from '../src/ume-reviews.js';
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

const umeItem = (id: string, title: string, at = ago(2 * HOUR)) =>
  umeReviewRequestItem(
    { id, title, kind: 'doc', rev: 3, approval: 'in-review', sets: 'set-1:plan' },
    { at, kind: 'review.requested', actor: 'alex00000001', by: 'agent', artifact: id, to: 'me0000000001' },
    { projectName: 'homebase', requester: { id: 'alex00000001', name: 'Alex Author' } },
  );

const fleet = () => ({ ...emptyFleet(), focusToken: 'tok', reviews: [review(7)] });

async function reviews(ume: UmeReviews | undefined, view = 'cards', reads?: string[]): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, fleet(), {
    now: NOW,
    hash: '#reviews',
    prefs: { view },
    ...(ume ? { ume } : {}),
    ...(reads
      ? {
          get: (url: string) => {
            if (url !== '/data/ume-reviews') return undefined;
            reads.push(url);
            return { status: 200, body: ume };
          },
        }
      : {}),
  });
  open.push(g);
  await g.settle();
  return g;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('the item card', () => {
  it('draws a GitHub review with the GitHub logo, the PR glyph, its chips and context', async () => {
    const g = await reviews(undefined);
    const card = g.$('#reviews [data-review="review:acme/web#7"]')!;
    expect(card.getAttribute('data-item-source')).toBe('github');
    expect(card.querySelector('.glead .srclogo')?.getAttribute('aria-label')).toBe('GitHub');
    expect(card.querySelector('.srclogo .srctip')?.textContent).toBe('GitHub');
    expect(card.querySelector('.gicon .prstate.pr-open .pricon')).not.toBeNull();
    expect(text(card.querySelector('.gstate'))).toContain('Open');
    expect(text(card.querySelector('.gstate'))).toContain('requested');
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^acme\/web · .+ ago · #7$/);
    expect(card.querySelector('.gavatar')?.getAttribute('title')).toBe('requested by: dana');
    expect(card.querySelector('.gactions .gopenbtn')?.getAttribute('href')).toBe('https://github.com/acme/web/pull/7/files');
    // Its review controls stay in the bar.
    expect(text(card.querySelector('.gactions'))).toContain('Review (draft)');
  });

  it('draws a ume artifact with the ume logo, the document glyph, kind, revision, who asked and when', async () => {
    const g = await reviews({ configured: true, items: [umeItem('a-1', 'Plan the importer')], problems: [] });
    const card = g.$('#reviews [data-item="ume:a-1"]')!;
    expect(card.getAttribute('data-item-source')).toBe('ume');
    expect(card.querySelector('.glead .srclogo')?.getAttribute('aria-label')).toBe('ume');
    expect(card.querySelector('.srclogo svg radialGradient')).not.toBeNull();
    expect(card.querySelector('.gicon .prstate.pr-open svg.hostglyph')).not.toBeNull();
    expect(text(card.querySelector('.gtitle'))).toBe('Plan the importer');
    expect(text(card.querySelector('.gstate'))).toBe('In review');
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^homebase · plan · revision 3 · asked by Alex Author’s agent · .+ ago$/);
    expect(card.querySelector('.gavatar')?.getAttribute('title')).toBe('requested by: alex00000001 (Alex Author’s agent)');
    expect(card.classList.contains('gedge-bad')).toBe(true);
    const action = card.querySelector('.gactions a')!;
    expect(text(action)).toBe('Open in ume');
    expect(action.getAttribute('href')).toBe('https://app.ume.so/a/a-1');
    expect(action.getAttribute('target')).toBe('_blank');
    // A tap on the card opens the artifact; a tap on the logo only names the source.
    (card.querySelector('.srclogo') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.opened()).toEqual([]);
    expect(card.querySelector('.srclogo')?.classList.contains('tip')).toBe(true);
    (card as unknown as HTMLElement).click();
    await g.settle();
    expect(g.opened()).toEqual([['https://app.ume.so/a/a-1', '_blank', 'noopener']]);
  });
});

describe('Reviews with GitHub and ume rows', () => {
  it.each(['cards', 'table'])('shows GitHub rows and the ume section together in %s', async (view) => {
    const g = await reviews(
      { configured: true, items: [umeItem('a-new', 'Newer plan', ago(HOUR)), umeItem('a-old', 'Older plan')], problems: [] },
      view,
    );
    const sections = g.$$('#reviews [data-review-section]').map((s) => s.getAttribute('data-review-section'));
    expect(sections).toEqual(['needs', 'ume', 'waiting', 'done']);
    expect(g.$('#reviews [data-review-section="needs"] [data-review="review:acme/web#7"]')).not.toBeNull();
    const ume = g.$('#reviews [data-review-section="ume"]')!;
    expect(text(ume.querySelector('h2'))).toBe('Needs your review in ume (2)');
    expect([...ume.querySelectorAll('[data-item]')].map((c) => c.getAttribute('data-item'))).toEqual(['ume:a-new', 'ume:a-old']);
    expect(ume.querySelector('[data-ume-note]')).toBeNull();
  });

  it('says once that ume is missing and keeps the GitHub rows', async () => {
    const g = await reviews({ configured: true, items: [], missing: true, problems: [] });
    expect(g.$('#reviews [data-review="review:acme/web#7"]')).not.toBeNull();
    const ume = g.$('#reviews [data-review-section="ume"]')!;
    expect(text(ume.querySelector('h2'))).toBe('Needs your review in ume (0)');
    expect(ume.querySelectorAll('[data-ume-note]')).toHaveLength(1);
    expect(text(ume.querySelector('[data-ume-note]'))).toBe('Install the ume CLI to see ume reviews here.');
    expect(ume.querySelector('.empty')).toBeNull();
  });

  it('names a project that failed beside the ones it read', async () => {
    const g = await reviews({ configured: true, items: [umeItem('a-1', 'Plan the importer')], problems: [{ project: 'p-x', reason: 'offline' }] });
    const ume = g.$('#reviews [data-review-section="ume"]')!;
    expect(ume.querySelector('[data-item="ume:a-1"]')).not.toBeNull();
    expect(text(ume.querySelector('[data-ume-note]'))).toBe('Couldn’t read ume project p-x (offline).');
    expect(g.$('#reviews [data-review="review:acme/web#7"]')).not.toBeNull();
  });

  it('says when no ume review needs you', async () => {
    const g = await reviews({ configured: true, items: [], problems: [] });
    expect(text(g.$('#reviews [data-review-section="ume"] .empty'))).toBe('No ume reviews need you');
  });

  it('shows no ume section without configured projects', async () => {
    const g = await reviews(undefined);
    expect(g.$('#reviews [data-review-section="ume"]')).toBeNull();
    expect(g.$('#reviews [data-review="review:acme/web#7"]')).not.toBeNull();
  });

  it('reads ume when Reviews opens, not on every poll, and again when Reviews opens later', async () => {
    const reads: string[] = [];
    const g = await reviews({ configured: true, items: [], problems: [] }, 'cards', reads);
    expect(reads).toHaveLength(1);
    await g.poll();
    await g.poll();
    expect(reads).toHaveLength(1);
    await g.go('#prs');
    await g.poll();
    expect(reads).toHaveLength(1);
    await g.go('#reviews');
    expect(reads).toHaveLength(2);
  });
});
