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
  // On the PRs tab a stack shows its PRs' cards once open (prs.ts StackCard): open them, as clicks would.
  if (hash === '#prs') {
    for (const s of g.$$('#prs .stackcard[aria-expanded="false"]')) (s as HTMLElement).click();
    await g.settle();
  }
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
  it('leads with its state-colored PR icon and title, then its state chip, then repo · age · #number · trap · checks, then its buttons', async () => {
    const d = acceptanceFleet();
    const p = d.prs.find((x) => x.number === 41)!;
    const g = await page(d, '#prs');
    const card = g.$$('#prs .card').find((c) => text(c.querySelector('.gcontext')).includes('#41'))!;
    expect(card.className).toContain(`gcard-edge gedge-${p.badge.tone}`);
    // 1. The PR icon before the title, in the PR's state color.
    const top = card.querySelector('.gtop')!;
    expect(top.firstElementChild?.querySelector('.prstate.pr-open .pricon')).toBeTruthy();
    expect(top.querySelector('.gword, .gchip')).toBeNull();
    // 2. GitHub's state as a chip; a green badge adds nothing.
    expect(card.querySelectorAll('.gtop + .gstate .gchip').length).toBe(1);
    expect(text(card.querySelector('.gstate .gchip.pr-open'))).toBe('Open');
    // 3. The meta line: its dispatches' trap is the first one a trap was addressed or claimed.
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^web · \d+\w ago · #41 · 🪤 wt:t1 · 4\/4 passed$/);
    expect(card.querySelector('.gcontext .reponame svg.repoicon')).toBeTruthy();
    // 4. The buttons, in a bar of their own.
    expect(card.querySelectorAll(':scope > .gline')).toHaveLength(4);
    expect(card.lastElementChild?.className).toContain('gactions');
    // The gate stays in the modal.
    expect(text(card)).not.toContain('gate');
    // ↗ Open leaves the card alone; the card opens the PR's modal, gate and all.
    const openLink = card.querySelector('.gactions a.open')!;
    expect([text(openLink), openLink.getAttribute('target')]).toEqual(['↗ Open', '_blank']);
    await click(g, openLink);
    expect(g.$('#overlay')!.className).not.toBe('open');
    await click(g, card);
    expect(text(g.$('#modalbox .sub'))).toContain('gate waiting-approval');
  });

  it('chips what a badge that is not green says, and offers Merge when green and Ack only where they apply', async () => {
    const d = acceptanceFleet();
    const p = d.prs.find((x) => x.number === 41)!;
    Object.assign(p, { mine: true, badge: { ...p.badge, tone: 'bad', text: 'Conflicts' } });
    const other = d.prs.find((x) => x.number === 42)!;
    other.mine = false;
    d.attention = [{ kind: 'pr:conflict', key: p.key, lane: 'work', note: 'conflicts', ageSecs: 0, stateHash: 'h41' } as never];
    const g = await page({ ...d, focusToken: 'tok' }, '#prs');
    const card = (n: number) => g.$$('#prs .card').find((c) => text(c.querySelector('.gcontext')).includes(`#${n}`))!;
    expect([...card(41).querySelectorAll('.gstate .gchip')].map(text)).toEqual(['Open', 'conflicts']);
    expect([...card(41).querySelectorAll('.gactions button')].map(text)).toEqual(['Merge when green', 'Ack']);
    expect([...card(42).querySelectorAll('.gactions button')].map(text)).toEqual([]);
    expect([...card(42).querySelectorAll('.gactions a')].map(text)).toEqual(['↗ Open']);
    // Merge when green still asks before it merges, and a tap on the bar never opens the card.
    await click(
      g,
      [...card(41).querySelectorAll('.gactions button')].find((b) => text(b) === 'Merge when green'),
    );
    expect(g.$('#overlay')!.className).not.toBe('open');
    expect(text(card(41).querySelector('.gactions .prmerge.asking'))).toContain('Merge #41 into');
    expect(g.posts()).toEqual([]);
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
  it('is a PR card: icon and title, its status chip, then repo · age · #number · trap, then its actions and Open draft', async () => {
    const d = {
      ...emptyFleet(),
      focusToken: 'tok',
      dispatches: acceptanceFleet().dispatches,
      reviews: [
        review(7, {
          state: 'drafted',
          verdict: 'approve',
          needsYou: true,
          staged: true,
          stagedReviewUrl: 'https://github.com/acme/web/pull/7#pullrequestreview-1',
          dispatch: 'cccccccc-0000-4000-8000-000000000003',
        }),
        review(8, { state: 'drafting', stands: false }),
        review(9, { state: 'posted', stands: false, verdict: 'approve' }),
        review(10, { state: 'posted', stands: false, verdict: 'request_changes' }),
        review(11, { state: 'posted', stands: false, verdict: 'comment' }),
      ],
    };
    const g = await page(d, '#reviews', () => ({ status: 200, body: { ok: true } }));
    const card = (n: number) => g.$(`#reviews [data-review="review:acme/web#${n}"]`)!;
    const chips = (n: number) => [...card(n).querySelectorAll('.gtop + .gstate .gchip')].map(text);
    expect(card(7).className).toContain('gcard-edge gedge-bad');
    // The PR card's four parts.
    expect(card(7).querySelector('.gtop')!.firstElementChild?.querySelector('.pricon')).toBeTruthy();
    expect(card(7).querySelector('.gtop .gword, .gtop .gchip')).toBeNull();
    expect(chips(7)).toEqual(['draft ready', 'needs you']);
    expect(text(card(7).querySelector('.gcontext .gtext'))).toBe('acme/web · 60m ago · #7 · 🪤 wt:t1');
    expect(card(7).querySelector('.gcontext .reponame svg.repoicon')).toBeTruthy();
    expect(card(7).querySelectorAll(':scope > .gline')).toHaveLength(4);
    expect([...card(7).querySelectorAll('.gactions button, .gactions a')].map(text)).toEqual(['Approve', 'Skip', 'Open draft']);
    expect(chips(8)).toEqual(['drafting']);
    expect(chips(9)).toEqual(['approved']);
    expect(chips(10)).toEqual(['changes requested']);
    expect(chips(11)).toEqual(['posted']);
    // No trap has a round that ran no job.
    expect(text(card(8).querySelector('.gcontext .gtext'))).toBe('acme/web · 60m ago · #8');
    const draft = card(7).querySelector('.gactions a')!;
    expect([text(draft), draft.getAttribute('href')]).toEqual(['Open draft', 'https://github.com/acme/web/pull/7#pullrequestreview-1']);
    expect(card(8).className).toContain('gcard-edge gedge-warn');
    expect(text(card(8).querySelector('.gactions a'))).toBe('↗ Open');
    expect(card(9).className).toContain('gcard-edge gedge-ok');
    expect(card(9).className).toContain('quiet');
    // Who asked and the reason are in the modal, not on the card.
    expect(text(card(7))).not.toContain('maya');
    // Sending the review takes a second tap that says what it posts; Keep backs out, and the card never opens.
    const approve = () => [...card(7).querySelectorAll('.gactions button')].find((b) => text(b) === 'Approve');
    await click(g, approve());
    expect(g.$('#overlay')!.className).not.toBe('open');
    const sends = () => g.posts().filter((p) => JSON.parse(p.body).kind !== 'review-seen');
    expect(sends()).toEqual([]);
    await click(
      g,
      [...card(7).querySelectorAll('.gactions button')].find((b) => text(b) === 'Keep'),
    );
    await click(g, approve());
    await click(
      g,
      [...card(7).querySelectorAll('.gactions button')].find((b) => text(b) === 'Post approval on #7'),
    );
    expect(sends().map((p) => JSON.parse(p.body))).toEqual([{ kind: 'review-approve', payload: { key: 'review:acme/web#7' } }]);
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
