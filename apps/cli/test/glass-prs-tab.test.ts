import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
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

/** Adds #51, a merged PR the person owns, in a closed stack of its own. */
function withClosed(d: GlassFullSnapshot): GlassFullSnapshot {
  const lone = d.prs.find((p) => p.number === 50)!;
  const merged = {
    ...lone,
    key: 'pr:acme/web#51',
    url: 'https://github.com/acme/web/pull/51',
    number: 51,
    title: 'A merged PR',
    stackId: 'pr:acme/web#51',
    state: 'MERGED' as const,
    mergedAt: d.now,
    badge: { ...lone.badge, state: 'merged' as const },
    mine: true,
  };
  d.prs = [...d.prs.filter((p) => p.number !== 51), merged];
  d.stacks = [...d.stacks, { id: 'pr:acme/web#51', floor: 'main', repo: d.stacks[0]!.repo, numbers: [51], open: false, nextNumber: 51, behind: 0 }];
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

    it('counts only open PRs in the page header, never merged or closed ones', async () => {
      const d = withClosed(fleet([42, 43, 50, 51]));
      const closed = { ...d.prs.find((p) => p.number === 51)!, key: 'pr:acme/web#52', url: 'https://github.com/acme/web/pull/52', number: 52, title: 'A closed PR', stackId: 'pr:acme/web#52', state: 'CLOSED' as const, mergedAt: undefined, closedAt: d.now };
      d.prs = [...d.prs, closed];
      d.stacks = [...d.stacks, { id: 'pr:acme/web#52', floor: 'main', repo: d.stacks[0]!.repo, numbers: [52], open: false, nextNumber: 52, behind: 0 }];
      const g = await page(d, { hash: '#prs', prefs: { view } });
      expect(text(g.$('#prs .section-head .section-count'))).toBe('· 3');
      expect(text(g.$('#prs [data-pr-section="closed"]'))).toContain('A closed PR');
      expect(text(g.$('#prs [data-pr-section="open"] h2'))).toBe('Open');
      expect(text(g.$('#prs [data-pr-section="closed"] summary'))).toBe('Closed');
    });

    it('splits Open from a collapsed Closed section, with no counts, and remembers Closed for this viewer', async () => {
      const d = withClosed(fleet([50, 51]));
      const g = await page(d, { hash: '#prs', prefs: { view } });
      const openSection = g.$('#prs [data-pr-section="open"]')!;
      const closed = g.$('#prs [data-pr-section="closed"]')!;
      expect(text(openSection.querySelector('h2'))).toBe('Open');
      expect(closed.tagName).toBe('DETAILS');
      expect(text(closed.querySelector('summary'))).toBe('Closed');
      expect(closed.hasAttribute('open')).toBe(false);
      expect(text(openSection)).toContain('A lone PR');
      expect(text(openSection)).not.toContain('A merged PR');
      expect(text(closed)).toContain('A merged PR');
      closed.setAttribute('open', '');
      closed.dispatchEvent(new g.window.Event('toggle'));
      await g.settle();
      const prefs = JSON.parse(g.window.localStorage.getItem('spyglass')!);
      expect(prefs.prSections).toEqual({ closed: true });
      const reload = await page(d, { hash: '#prs', prefs });
      expect(reload.$('#prs [data-pr-section="closed"]')!.hasAttribute('open')).toBe(true);
    });

    it('keeps a stack with an open PR whole under Open, and says so when nothing is open', async () => {
      const g = await page(withClosed(fleet([42, 43, 51])), { hash: '#prs', prefs: { view } });
      await openStacks(g);
      expect(text(g.$('#prs [data-pr-section="open"]'))).toContain('#42');
      expect(g.$('#prs [data-pr-section="closed"]')!.textContent).not.toContain('#42');
      const onlyClosed = await page(withClosed(fleet([51])), { hash: '#prs', prefs: { view } });
      expect(text(onlyClosed.$('#prs [data-pr-section="open"] h2'))).toBe('Open');
      expect(text(onlyClosed.$('#prs [data-pr-section="open"] .empty'))).toBe('No open PRs');
      expect(text(onlyClosed.$('#prs [data-pr-section="closed"]'))).toContain('A merged PR');
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
      expect(text(g.$('#prs .merge-intent'))).toBe('Merge when green · Waiting on CI');
      cancel.click();
      await g.settle();
      expect(JSON.parse(g.posts().at(-1)!.body).payload).toEqual({ key: 'pr:acme/web#50', cancel: true });
      expect(button(g, 'Merge when green')).toBeDefined();
    });
  }

  /** A card the helm asked with `man ask --pr pr:acme/web#50`, open on the deck. */
  const CARD = 'decision:5050abcd';
  const withCard = (d: GlassFullSnapshot, prs = ['pr:acme/web#50']): GlassFullSnapshot => {
    d.attention = [...(d.attention ?? []), { kind: 'decision', key: CARD, stateHash: 'c1', verb: 'decision', ageSecs: 60, at: d.now, standingSince: d.now, note: 'Merge #50 when green?', repo: 'web' }];
    d.decisions = [...(d.decisions ?? []), { key: CARD, title: 'Merge #50 when green?', detail: '', options: ['Merge when green', 'Hold'], attachments: [],
      references: prs.map((key) => ({ kind: 'pr' as const, key })), askedBy: 'helm', askedAt: d.now, stateHash: 'c1' }];
    return d;
  };
  const waiting = (g: GlassDom, scope = '#prs') => g.$$(scope + ' .prmerge-card') as HTMLElement[];

  for (const view of ['cards', 'table'] as const) {
    it(`defers to an open linked card, and links to it, as ${view}`, async () => {
      const g = await page(withCard(mergeFleet()), { hash: '#prs', post: boat, prefs: { view } });
      expect(button(g, 'Merge when green')).toBeUndefined();
      expect(waiting(g).map(text)).toEqual(['Waiting on your card · open it']);
      const link = waiting(g)[0]!.querySelector('a')!;
      expect(link.getAttribute('href')).toBe('#decision/' + encodeURIComponent(CARD));
      link.click();
      await g.settle();
      expect(text(g.$('.dmodal .dtitle'))).toBe('Merge #50 when green?');
      expect(g.posts().filter((p) => JSON.parse(p.body).kind === 'pr-merge')).toHaveLength(0);
    });
  }

  it('keeps the button on a PR no open card is about', async () => {
    const g = await page(withCard(mergeFleet(), ['pr:acme/web#41']), { hash: '#prs', post: boat, prefs: { view: 'cards' } });
    expect(button(g, 'Merge when green')).toBeDefined();
    expect(waiting(g)).toHaveLength(0);
  });

  it('defers in the PR view too, and shows the button again once the card is withdrawn or answered', async () => {
    const g = await page(withCard(mergeFleet()), { hash: '#pr/' + encodeURIComponent('pr:acme/web#50'), post: boat });
    const merge = () => g.$$('.detail-frame button').some((b) => text(b) === 'Merge when green');
    expect(waiting(g, '.detail-frame').map(text)).toEqual(['Waiting on your card · open it']);
    expect(merge()).toBe(false);
    // Withdrawn: the card leaves the snapshot.
    g.serve(mergeFleet());
    await g.poll();
    expect(waiting(g, '.detail-frame')).toHaveLength(0);
    expect(merge()).toBe(true);
    // Answered and handed to the helm: no longer open either.
    const answered = withCard(mergeFleet());
    answered.decisions!.at(-1)!.handoff = { state: 'answered', answeredAt: answered.now };
    g.serve(answered);
    await g.poll();
    expect(waiting(g, '.detail-frame')).toHaveLength(0);
    expect(merge()).toBe(true);
  });

  it('shows no merge control inside the card it defers to', async () => {
    const g = await page(withCard(mergeFleet()), { hash: '#decision/' + encodeURIComponent(CARD), post: boat });
    expect(text(g.$('.dmodal .decision-embeds'))).toContain('A lone PR');
    expect(waiting(g, '.dmodal')).toHaveLength(0);
    expect(g.$$('.dmodal .decision-embeds button').some((b) => text(b) === 'Merge when green')).toBe(false);
  });

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
  it(`shows only the merge tag and short state on PRs and matching reviews as ${view}`, async () => {
    const d = fleet([50]);
    d.focusToken = 'token';
    const pr = d.prs.find((p) => p.number === 50)!;
    pr.mergeRequest = { at: '2026-11-16T18:00:00Z', by: 'decision:deploy', method: 'merge', note: 'Staging then production', hold: 'Run DB steps', summary: 'Waiting on CI' };
    d.reviews = [{ key: 'review:acme/web#50', repo: 'acme/web', number: 50, title: pr.title!, url: pr.url, reviewUrl: pr.url,
      author: 'chris', requestedAt: pr.observedAt, state: 'requested', stands: true }];
    const g = await page(d, { hash: '#prs', prefs: { view }, post: () => ({ status: 200, body: { ok: true } }) });
    for (const hash of ['#prs', '#reviews', '#pr/' + encodeURIComponent(pr.key)]) {
      await g.go(hash);
      const scope = hash.startsWith('#pr/') ? '.detail-frame' : hash;
      const intent = g.$(scope + ' .merge-intent');
      expect(text(intent)).toBe('Merge when green · On hold · Run DB steps');
      expect(intent?.querySelector('time')).toBeNull();
      for (const detail of ['You', 'decision:deploy', '2026-11-16T18:00:00Z', 'merge commit', 'Staging then production']) expect(text(intent)).not.toContain(detail);
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
  pr.mergeRequest = { at: '2026-11-16T18:00:00Z', by: 'chat', method: 'merge', summary, ...(summary === 'Merged' ? { mergeSha: 'abc123', hold: 'A previous hold' } : {}) };
  if (summary === 'Merged') { pr.state = 'MERGED'; pr.badge = { text: 'merged', state: 'merged', tone: 'dim' }; }
  const g = await page(d, { hash: '#prs', prefs: { view: 'cards' } });
  expect(text(g.$('#prs .merge-intent'))).toContain(summary);
  expect(text(g.$('#prs .merge-intent'))).toBe('Merge when green · ' + summary);
});


it('falls back to the waiting state without exposing the authorization source or method', async () => {
  const d = fleet([50]);
  d.prs.find((p) => p.number === 50)!.mergeRequest = { at: new Date(NOW).toISOString(), by: 'chat', method: 'squash' };
  const g = await page(d, { hash: '#prs', prefs: { view: 'cards' } });
  expect(text(g.$('#prs .merge-intent'))).toBe('Merge when green · Waiting on CI');
});
