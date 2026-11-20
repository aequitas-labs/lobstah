import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_SOURCE, reviewWatchItem } from '@lobstah/core';
import type { GlassReview, WatchSurfaceItem } from '@lobstah/core';
import type { WatchItem } from '@lobstah/watch-types';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, ago, emptyFleet } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

function review(n: number, over: Partial<GlassReview> = {}): GlassReview {
  return {
    key: `review:acme/web#${n}`,
    url: `https://github.com/acme/web/pull/${n}`,
    reviewUrl: `https://github.com/acme/web/pull/${n}`,
    repo: 'acme/web',
    number: n,
    title: `pr ${n}`,
    author: 'dana',
    repoKey: 'web',
    requestedBy: 'dana',
    requestedAt: ago(3600 + n),
    state: 'requested',
    stands: true,
    headSha: 'aaaaaaa1',
    prHeadSha: 'aaaaaaa1',
    ...over,
  };
}

const watch = { key: 'review-requests:dana', generation: 'g1', type: 'review-requests', status: 'watching' as const };
const asItem = (r: GlassReview): WatchSurfaceItem => ({ watch, source: GITHUB_SOURCE, item: reviewWatchItem(r, { canDraft: true, publish: false }) });

/** Every round state and PR lifecycle the Reviews page shows, as GitHub records them. */
const gallery = (): GlassReview[] => [
  review(7, { state: 'drafted', staged: true, verdict: 'comment', notification: { kind: 'draft-ready', at: ago(60), text: 'Draft ready' } }),
  review(8),
  review(9, { state: 'stale', reason: 'the head moved' }),
  review(10, { state: 'posted', stands: false, verdict: 'approve', postedAt: ago(30), postedReviewUrl: 'https://github.com/acme/web/pull/10#pullrequestreview-1' }),
  review(11, { state: 'failed', reason: 'draft failed' }),
  review(12, { state: 'dismissed', stands: false }),
  review(13, { prState: 'MERGED', state: 'merged', stands: false }),
  review(14, { prState: 'CLOSED', state: 'closed', stands: false }),
  review(15, { prDraft: true }),
  review(16, { mutedAt: ago(10), stands: false }),
  review(17, { state: 'posted', verdict: 'approve', reReview: { headSha: 'bbbbbbb2', at: ago(20) }, stands: true }),
];

/** A card's or row's words, without the source logo and the separator after it, which the legacy card did not have. */
function words(element: Element | null): string {
  const clone = element!.cloneNode(true) as Element;
  for (const logo of [...clone.querySelectorAll('.glead')]) {
    const text = logo.parentElement?.querySelector('.gtext');
    if (text?.firstChild?.textContent === ' · ') text.firstChild.textContent = '';
    logo.textContent = '';
  }
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function glass(snapshot: Record<string, unknown>, view: 'cards' | 'table' = 'cards', post?: Parameters<typeof loadGlass>[2]['post']) {
  const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', ...snapshot } as never, { now: NOW, hash: '#reviews', prefs: { view }, post });
  open.push(g);
  return g;
}

describe('Reviews from source items', () => {
  it.each(['cards', 'table'] as const)('renders the same %s, sections and badge as the GitHub records', async (view) => {
    const reviews = gallery();
    const legacy = await glass({ reviews }, view);
    const items = await glass({ reviews, reviewItems: reviews.map(asItem) }, view);
    const rows = (g: GlassDom) => g.$$('#reviews [data-review]').map((element) => element.getAttribute('data-review'));
    expect(rows(items)).toEqual(rows(legacy));
    expect(items.$$('#reviews .rv-section > h2, #reviews .rv-section > summary').map((head) => head.textContent)).toEqual(
      legacy.$$('#reviews .rv-section > h2, #reviews .rv-section > summary').map((head) => head.textContent),
    );
    expect(items.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe(legacy.$('#tabs [data-tab="reviews"] .dbadge')?.textContent);
    for (const key of rows(legacy)) {
      const select = (g: GlassDom) => g.$(`#reviews [data-review="${key}"]`);
      if (view === 'cards') {
        // The card's words, chips, unread marks and quiet state match; only the source logo is new.
        // A card's status line lays out its parts itself, so spaces between them do not show.
        expect(words(select(items)).replace(/\s/g, '')).toBe(words(select(legacy)).replace(/\s/g, ''));
        expect(select(items)!.className).toBe(select(legacy)!.className);
        expect(select(items)!.querySelectorAll('[data-review-unread]').length).toBe(select(legacy)!.querySelectorAll('[data-review-unread]').length);
        expect(select(items)!.querySelector('.glead [aria-label="GitHub"]')).not.toBeNull();
      } else {
        // Every column but the controls matches.
        const cells = (g: GlassDom) => [...select(g)!.querySelectorAll('td')].slice(0, 6).map(words);
        expect(cells(items)).toEqual(cells(legacy));
        expect(select(items)!.className).toBe(select(legacy)!.className);
      }
    }
  });

  it('falls back to the legacy records only when the item collection is absent', async () => {
    const empty = await glass({ reviews: [review(7)], reviewItems: [] });
    expect(empty.$$('#reviews [data-review]')).toHaveLength(0);
    expect(empty.$('#reviews')?.textContent).toContain('No reviews need you');
    const older = await glass({ reviews: [review(7)] });
    expect(older.$$('#reviews [data-review]')).toHaveLength(1);
  });

  it('shows the source logo alone, named for screen readers and on hover, focus or tap, without opening the card', async () => {
    const g = await glass({ reviews: [review(7)], reviewItems: [asItem(review(7))] });
    const logo = g.$('#reviews [data-review="review:acme/web#7"] .glead button') as unknown as HTMLElement;
    expect(logo.getAttribute('aria-label')).toBe('GitHub');
    expect(logo.querySelector('svg')).not.toBeNull();
    expect(logo.querySelector('.srctip')?.textContent).toBe('GitHub');
    // Only the logo sits in the context line's leading slot; the name is not persistent text.
    expect(g.$('#reviews [data-review="review:acme/web#7"] .gcontext .gtext')?.textContent).not.toContain('GitHub');
    logo.click();
    await g.settle();
    expect(logo.classList.contains('tip')).toBe(true);
    expect(g.$('#modalbox')?.textContent ?? '').not.toContain('pr 7');
    logo.click();
    await g.settle();
    expect(logo.classList.contains('tip')).toBe(false);
  });

  it('keeps the name and falls back to the glyph when a source logo fails to load', async () => {
    const entry = { ...asItem(review(7)), source: { id: 'fixture', name: 'Fixture source', icon: { asset: { light: 'https://example.test/l.png', dark: 'https://example.test/d.png' }, fallback: 'source' as const } } };
    const g = await glass({ reviewItems: [entry] });
    const logo = g.$('#reviews .glead button')!;
    expect(logo.getAttribute('aria-label')).toBe('Fixture source');
    logo.querySelector('img')!.dispatchEvent(new g.window.Event('error') as never);
    await g.settle();
    expect(logo.querySelector('img')).toBeNull();
    expect(logo.querySelector('svg')).not.toBeNull();
    expect(logo.getAttribute('aria-label')).toBe('Fixture source');
  });

  it('runs a control through the generic item action without opening or acknowledging the card', async () => {
    const r = review(7, { state: 'drafted', verdict: 'comment', notification: { kind: 'draft-ready', at: ago(60), text: 'Draft ready' } });
    const entry = asItem(r);
    const g = await glass({ reviews: [r], reviewItems: [entry] }, 'cards', () => ({ status: 200, body: { ok: true } }));
    const publish = g.$$('#reviews [data-review="review:acme/web#7"] button').find((button) => button.textContent === 'Publish') as unknown as HTMLElement;
    publish.click();
    await g.settle();
    const bodies = g.posts().map((post) => JSON.parse(post.body));
    expect(bodies).toEqual([
      {
        kind: 'watch-item-action',
        payload: {
          watch: 'review-requests:dana',
          generation: 'g1',
          item: 'review:acme/web#7',
          control: 'publish',
          revision: entry.item.revision,
          idempotencyKey: expect.any(String),
        },
      },
    ]);
    expect(g.$('#modalbox [data-review]')).toBeNull();
  });

  it('confirms Approve anyway in the page before sending it', async () => {
    const r = review(7, { state: 'drafted', verdict: 'comment' });
    const g = await glass({ reviews: [r], reviewItems: [asItem(r)] }, 'cards', () => ({ status: 200, body: { ok: true } }));
    (g.$('#reviews [data-review="review:acme/web#7"] [aria-label="More actions"]') as unknown as HTMLElement).click();
    await g.settle();
    (g.$$('#reviews [role="menuitem"]').find((button) => button.textContent?.includes('Approve anyway')) as unknown as HTMLElement).click();
    await g.settle();
    expect(g.posts()).toEqual([]);
    const dialog = g.$('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Approve #7?');
    ([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Approve anyway') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.posts().map((post) => JSON.parse(post.body).payload.control)).toEqual(['approve-anyway']);
  });

  it('Open acknowledges only the shown notification revision and lowers the badge at once', async () => {
    const r = review(7, { state: 'drafted', verdict: 'comment', notification: { kind: 'draft-ready', at: ago(60), text: 'Draft ready' } });
    const entry = asItem(r);
    const read = { ...entry, item: { ...entry.item, notification: { ...entry.item.notification!, unread: false, seen: true } } };
    const g: GlassDom = await glass({ reviews: [r], reviewItems: [entry] }, 'cards', () => {
      g.serve({ ...emptyFleet(), focusToken: 'tok', reviews: [r], reviewItems: [read] } as never);
      return { status: 200, body: { ok: true } };
    });
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('1');
    (g.$('#reviews [data-review="review:acme/web#7"] .gopenbtn') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.posts().map((post) => JSON.parse(post.body).payload.control)).toEqual([{ acknowledge: entry.item.notification!.revision }]);
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')).toBeNull();
  });

  it('refreshes quietly on a conflict and toasts any other refusal', async () => {
    const r = review(7, { state: 'drafted', verdict: 'comment' });
    let reply = { status: 409, body: { ok: false, reason: 'This item changed. Its controls were refreshed.', conflict: true } };
    const g = await glass({ reviews: [r], reviewItems: [asItem(r)] }, 'cards', () => reply);
    const publish = () => g.$$('#reviews [data-review="review:acme/web#7"] button').find((button) => button.textContent === 'Publish') as unknown as HTMLElement;
    const before = g.fetches();
    publish().click();
    await g.settle();
    expect(g.$$('.toast-content')).toHaveLength(0);
    expect(g.fetches()).toBeGreaterThan(before);
    reply = { status: 409, body: { ok: false, reason: 'This review has already been published.', conflict: false } };
    publish().click();
    await g.settle();
    expect(g.$$('.toast-content').map((toast) => toast.textContent)).toEqual(['This review has already been published.']);
  });

  it('keeps a held source’s items visible with its effects disabled and a reason', async () => {
    const r = review(7, { state: 'drafted', verdict: 'comment' });
    const g = await glass({ reviewItems: [{ ...asItem(r), watch: { ...watch, status: 'held' } }] });
    const publish = g.$$('#reviews [data-review="review:acme/web#7"] button').find((button) => button.textContent === 'Publish')!;
    expect(publish.hasAttribute('disabled')).toBe(true);
    expect(publish.getAttribute('title')).toContain('This source is unavailable');
    expect(g.$('#reviews [data-review="review:acme/web#7"] .gopenbtn')).not.toBeNull();
  });
});

describe('lifecycle, attention and seen stay separate', () => {
  const item = (over: Partial<WatchItem>): WatchSurfaceItem => {
    const base = asItem(review(7)).item;
    return { watch, source: GITHUB_SOURCE, item: { ...base, ...over } };
  };
  it.each([
    ['active', 'Open', 'pr-open', true],
    ['draft', 'Draft', 'pr-draft', true],
    ['completed', 'Merged', 'pr-merged', false],
    ['closed', 'Closed', 'pr-closed', false],
  ] as const)('shows a %s item in its lifecycle color, with an edge only while it is not finished', async (phase, label, token, edged) => {
    const g = await glass({ reviewItems: [item({ lifecycle: { phase, label }, attention: 'ready' })] });
    const card = g.$('#reviews [data-review]')!;
    expect(card.querySelector(`.gstate .gchip.${token}`)?.textContent).toBe(label);
    expect(card.querySelector(`.gtop .prstate.${token}`)).not.toBeNull();
    expect(card.classList.contains('gcard-edge')).toBe(edged);
  });

  it('keeps an archived completed item purple, with a neutral archived chip and no edge', async () => {
    const g = await glass({ reviewItems: [item({ lifecycle: { phase: 'completed', label: 'Approved', archived: true }, attention: 'ready' })] });
    const card = g.$('#reviews [data-review]')!;
    expect(card.querySelector('.gstate .gchip.pr-merged')?.textContent).toBe('Approved');
    expect(card.querySelector('.gstate .gchip.dim')?.textContent).toBe('archived');
    expect(card.classList.contains('gcard-edge')).toBe(false);
  });

  it('shows only Open in the bar of an item whose source offers no other control', async () => {
    const g = await glass({ reviewItems: [item({ actions: [{ id: 'open', label: 'Open in ume', placement: 'open', enabled: true, binding: { link: { href: 'https://app.ume.so/a/x' } } }] })] });
    const bar = g.$('#reviews [data-review] .gactions')!;
    expect(bar.textContent?.trim()).toBe('');
    expect(bar.querySelector('[aria-label="Open in ume"]')).not.toBeNull();
  });

  it('a seen item stays open and keeps its lifecycle; a resolved one is quiet without changing lifecycle', async () => {
    const seen = item({ notification: { revision: 'n', unread: false, seen: true } });
    const resolved = item({ id: 'review:acme/web#8', resolved: true });
    const g = await glass({ reviewItems: [seen, resolved] });
    const [first, second] = [g.$('#reviews [data-review="review:acme/web#7"]')!, g.$('#reviews [data-review="review:acme/web#8"]')!];
    expect(first.classList.contains('seen')).toBe(true);
    expect(first.classList.contains('quiet')).toBe(false);
    expect(first.querySelector('.gchip.pr-open')).not.toBeNull();
    expect(second.classList.contains('quiet')).toBe(true);
    expect(second.querySelector('.gchip.pr-open')).not.toBeNull();
  });
});

describe('Reviews with several sources', () => {
  const umeWatch = { key: 'ume-reviews:ourrwyi8p5', generation: 'u1', type: 'ume-reviews', status: 'watching' as const };
  const umeSource = { id: 'ume', name: 'ume', icon: { glyph: 'ume' as const } };
  const umeItem = (artifact: string, since: string, over: Partial<WatchItem> = {}): WatchSurfaceItem => ({
    watch: umeWatch,
    source: umeSource,
    item: {
      id: `ourrwyi8p5/chris/${artifact}`,
      revision: `2:${artifact}`,
      title: `Plan ${artifact}`,
      kind: 'document',
      glyph: { kind: 'document' },
      lifecycle: { phase: 'active', label: 'Active' },
      statuses: [{ code: 'approval-requested', label: 'approval requested', category: 'workflow', meaning: 'pending' }],
      attention: 'needs-you',
      notification: { revision: `a@${since}`, unread: true, action: 'ume-review-seen' },
      standing: true,
      metadata: [{ kind: 'project', value: 'lobstah' }, { kind: 'time', value: since }, { kind: 'revision', value: 'plan r2' }],
      requestedAt: since,
      target: { href: `https://app.ume.so/a/${artifact}` },
      actions: [{ id: 'open', label: 'Open in ume', placement: 'open', enabled: true, acknowledges: true, binding: { link: { href: `https://app.ume.so/a/${artifact}` } } }],
      surfaces: { list: ['reviews'], home: 'reviews' },
      ...over,
    },
  });
  const github = review(7, { state: 'drafted', verdict: 'comment', notification: { kind: 'draft-ready', at: ago(60), text: 'Draft ready' }, requestedAt: ago(7200) });
  const sources = [
    { watch, source: GITHUB_SOURCE, health: 'healthy' as const },
    { watch: umeWatch, source: umeSource, health: 'stale' as const, message: 'ume access to this project was lost.', remedy: 'Sign this machine in to ume again.' },
  ];
  const snapshot = () => ({
    reviewSetup: { enabled: false, mode: 'notify', running: false },
    reviews: [github],
    reviewItems: [asItem(github), umeItem('plan-1', ago(600)), umeItem('plan-2', ago(30), { notification: { revision: 'b', unread: false, seen: true } })],
    reviewSources: sources,
  });

  it('orders unread waiting items first, then the newest, and keeps each source logo, link and Open in ume', async () => {
    const g = await glass(snapshot());
    expect(g.$$('#reviews [data-review]').map((card) => card.getAttribute('data-review'))).toEqual([
      'ourrwyi8p5/chris/plan-1',
      'review:acme/web#7',
      'ourrwyi8p5/chris/plan-2',
    ]);
    const ume = g.$('#reviews [data-review="ourrwyi8p5/chris/plan-1"]')!;
    expect(ume.querySelector('.glead [aria-label="ume"]')).not.toBeNull();
    expect(ume.querySelector('.gopenbtn')?.getAttribute('aria-label')).toBe('Open in ume');
    expect(ume.querySelector('.gcontext')?.textContent).not.toContain('#');
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('2');
  });

  it('names the GitHub settings, keeps setup off the page-wide error, and shows each source its own stale notice', async () => {
    const g = await glass(snapshot());
    expect(g.$('#reviews .empty')).toBeNull();
    expect(g.$('#reviews .rv-controls')?.textContent).toContain('GitHub reviews are off');
    const notice = g.$('#reviews [data-review-source="ume"]')!;
    expect(notice.textContent).toContain('ume access to this project was lost.');
    expect(g.$('#reviews [data-review-source="github"]')).toBeNull();
  });

  it('filters to one source with the segmented control and remembers it', async () => {
    const g = await glass(snapshot());
    const choose = (name: string) => (g.$$('#reviews .rv-sources button').find((button) => button.textContent === name) as unknown as HTMLElement).click();
    expect(g.$$('#reviews .rv-sources button').map((button) => button.textContent)).toEqual(['All sources', 'GitHub', 'ume']);
    choose('GitHub');
    await g.settle();
    expect(g.$$('#reviews [data-review]').map((card) => card.getAttribute('data-review'))).toEqual(['review:acme/web#7']);
    expect(g.$('#reviews [data-review-source="ume"]')).toBeNull();
    expect(JSON.parse(g.window.localStorage.getItem('spyglass')!).reviewSource).toBe('github');
    choose('All sources');
    await g.settle();
    expect(g.$$('#reviews [data-review]')).toHaveLength(3);
  });
});
