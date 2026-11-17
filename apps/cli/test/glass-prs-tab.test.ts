import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { mergeIntentTime } from '../../../packages/glass-ui/ui/components/prs.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';

/** The PRs tab lists owned PRs in both layouts; review requests stay on Reviews. */

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
/** Open every stack card, as clicks would: the cards view shows a stack's PRs only once it is open. */
async function openStacks(g: GlassDom): Promise<void> {
  for (const card of g.$$('#prs .stackcard')) (card as HTMLElement).click();
  await g.settle();
}

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
    it('lists only owned PRs without an ownership section split', async () => {
      const d = fleet([50]);
      d.reviews = [{ key: 'review:acme/web#41', repo: 'acme/web', number: 41, title: 'A requested review', url: d.prs[0]!.url, reviewUrl: d.prs[0]!.url, author: 'dana', requestedAt: d.now, state: 'requested', stands: true }];
      const g = await page(d, { hash: '#prs', prefs: { view } });
      await openStacks(g);
      expect(text(g.$('#prs'))).toContain('A lone PR');
      for (const number of ['#41', '#42', '#43']) expect(text(g.$('#prs'))).not.toContain(number);
      expect(text(g.$('#prs'))).not.toMatch(/Yours|Other PRs/);
      expect(text(g.$('#prs .section-head'))).toContain('1');
      await g.go('#reviews');
      expect(text(g.$('#reviews'))).toContain('A requested review');
    });

    it('filters non-owned members out of a mixed stack', async () => {
      const g = await page(fleet([42]), { hash: '#prs', prefs: { view } });
      await openStacks(g);
      expect(text(g.$('#prs'))).toContain('#42');
      const listed = view === 'table' ? g.$$('#prs tr.rowhead td:first-child').map(text) : g.$$('#prs .prcard .gcontext').map(text);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toContain('#42');
    });

    it('explains how to add an owned PR when none is watched', async () => {
      const g = await page(fleet([]), { hash: '#prs', prefs: { view } });
      expect(text(g.$('#prs'))).toContain('lobstah watch add <url>');
      expect(text(g.$('#prs'))).not.toMatch(/Yours|Other PRs|#41/);
    });
  });
}

it('leaves Reviews its own tab', async () => {
  const g = await page(fleet([50]), { hash: '#reviews' });
  expect(g.$('#tabs a[href="#reviews"]')?.className).toContain('on');
  expect(g.$('#reviews .yourshead')).toBeNull();
});

describe('Merge when green', () => {
  /** A boat that stores the request, as glass.ts does. */
  const boat: GlassDomOptions['post'] = (_url, req) => {
    const { kind, payload } = JSON.parse(req.body);
    expect(kind).toBe('pr-merge');
    return { status: 200, body: payload.cancel ? { ok: true, key: payload.key, cancelled: true } : { ok: true, key: payload.key, method: 'merge' } };
  };
  const mergeFleet = () => {
    const d = fleet([50]);
    d.focusToken = 'page-token';
    d.prs = d.prs.map((p) => (p.number === 50 ? { ...p, mergeMethod: 'merge' as const } : p));
    return d;
  };
  const button = (g: GlassDom, label: string) => g.$$('#prs button').find((b) => text(b) === label) as HTMLElement | undefined;

  for (const view of ['cards', 'table'] as const) {
    it(`asks the boat in one click, the repo's way, then offers Cancel merge, as ${view}`, async () => {
      const g = await page(mergeFleet(), { hash: '#prs', post: boat, prefs: { view } });
      // Only your PR has it, and its hover says what it merges into and how; the card offers no other choice.
      expect(g.$$('#prs button').filter((b) => text(b) === 'Merge when green')).toHaveLength(1);
      expect(button(g, 'Merge when green')!.getAttribute('title')).toBe('Merges #50 into main as a merge commit once green');
      button(g, 'Merge when green')!.click();
      await g.settle();
      expect(JSON.parse(g.posts().at(-1)!.body)).toMatchObject({ kind: 'pr-merge', payload: { key: 'pr:acme/web#50' } });
      expect(button(g, 'Keep')).toBeUndefined();
      const cancel = button(g, 'Cancel merge')!;
      expect(cancel.getAttribute('aria-pressed')).toBe('true');
      expect(text(g.$('#prs .merge-intent'))).toContain('Merge when green');
      expect(text(g.$('#prs .merge-intent'))).toContain('Waiting on CI');
      expect(text(g.$('#prs .merge-intent'))).toContain('You · merge card ·');
      cancel.click();
      await g.settle();
      expect(JSON.parse(g.posts().at(-1)!.body).payload).toEqual({ key: 'pr:acme/web#50', cancel: true });
      expect(button(g, 'Merge when green')).toBeDefined();
    });
  }

  it('shows why the boat refused', async () => {
    const g = await page(mergeFleet(), {
      hash: '#prs',
      post: () => ({ status: 403, body: { ok: false, reason: 'Only your own PRs, or ones a dispatch opened, merge from the glass.' } }),
    });
    button(g, 'Merge when green')!.click();
    await g.settle();
    expect(text(g.$('#prs [role="alert"]'))).toBe('Only your own PRs, or ones a dispatch opened, merge from the glass.');
  });
});

for (const view of ['cards', 'table'] as const) {
  it(`shows authorization, hold, and status on PRs and matching reviews as ${view}`, async () => {
    const d = fleet([50]);
    d.focusToken = 'token';
    const pr = d.prs.find((p) => p.number === 50)!;
    pr.mergeRequest = { at: '2026-11-16T18:00:00Z', by: 'decision:deploy', method: 'merge', note: 'Staging then production', hold: 'Run DB steps', summary: 'Held: Run DB steps' };
    d.reviews = [{ key: 'review:acme/web#50', repo: 'acme/web', number: 50, title: pr.title!, url: pr.url, reviewUrl: pr.url,
      author: 'chris', requestedAt: pr.observedAt, state: 'requested', stands: true }];
    const g = await page(d, { hash: '#prs', prefs: { view }, post: () => ({ status: 200, body: { ok: true } }) });
    for (const hash of ['#prs', '#reviews', '#pr/' + encodeURIComponent(pr.key)]) {
      await g.go(hash);
      const scope = hash.startsWith('#pr/') ? '.detail-frame' : hash;
      expect(text(g.$(scope))).toContain('Merge when green');
      expect(text(g.$(scope))).toContain('You · merge card ·');
      expect(text(g.$(scope))).not.toContain('decision:deploy');
      expect(text(g.$(scope))).not.toContain('2026-11-16T18:00:00Z');
      expect(text(g.$(scope))).toContain('merge commit');
      expect(text(g.$(scope))).toContain('On hold · Run DB steps');
      expect(text(g.$(scope))).toContain('Run DB steps');
      expect(text(g.$(scope))).toContain('Staging then production');
      expect([...g.$$(scope + ' button')].some((b) => text(b) === 'Cancel merge')).toBe(true);
    }
    const cancel = g.$$('.detail-frame button').find((b) => text(b) === 'Cancel merge') as HTMLElement;
    cancel.click(); await g.settle();
    expect(JSON.parse(g.posts().at(-1)!.body)).toMatchObject({ kind: 'pr-merge', payload: { key: pr.key, cancel: true } });
    expect(g.$('.detail-frame .merge-intent')).toBeNull();
  });
}

it.each(['Waiting on CI', 'CI failed', 'Conflict', 'Merging', 'Merged'])('shows the current merge status: %s', async (summary) => {
  const d = fleet([50]);
  const pr = d.prs.find((p) => p.number === 50)!;
  pr.mergeRequest = { at: '2026-11-16T18:00:00Z', by: 'chat', method: 'merge', summary, ...(summary === 'Merged' ? { mergeSha: 'abc123' } : {}) };
  if (summary === 'Merged') { pr.state = 'MERGED'; pr.badge = { text: 'merged', state: 'merged', tone: 'dim' }; }
  const g = await page(d, { hash: '#prs', prefs: { view: 'cards' } });
  expect(text(g.$('#prs .merge-intent'))).toContain(summary);
  if (summary === 'Merged') expect(text(g.$('#prs .merge-intent'))).toContain('abc123');
});


it('formats authorization times in the local clock, with the weekday for an earlier day', () => {
  const now = new Date(2026, 10, 17, 15, 0).getTime();
  expect(mergeIntentTime(new Date(2026, 10, 17, 14, 0).toISOString(), now)).toBe('2:00 PM');
  expect(mergeIntentTime(new Date(2026, 10, 16, 16, 12).toISOString(), now)).toBe('Mon 4:12 PM');
  expect(mergeIntentTime('not a date', now)).toBe('Time unavailable');
});

it('shows chat authorization and the squash method in human words', async () => {
  const d = fleet([50]);
  d.prs.find((p) => p.number === 50)!.mergeRequest = { at: new Date(NOW).toISOString(), by: 'chat', method: 'squash' };
  const g = await page(d, { hash: '#prs', prefs: { view: 'cards' } });
  expect(text(g.$('#prs .merge-intent'))).toContain('You · chat ·');
  expect(text(g.$('#prs .merge-intent'))).toContain('squash');
});
