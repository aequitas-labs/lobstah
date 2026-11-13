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
  it('leads with its state-colored PR icon and title, then its state chip, then repo · age · #number · trap, then its buttons', async () => {
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
    // 3. The meta line: its dispatches' trap is the first one a trap was addressed or claimed. The checks' breakdown is a checks chip's hover, never here.
    expect(text(card.querySelector('.gcontext .gtext'))).toMatch(/^web · \d+\w ago · #41 · 🪤 wt:t1$/);
    expect(card.querySelector('.gcontext .reponame svg.repoicon')).toBeTruthy();
    // 4. The buttons, in a bar of their own.
    expect(card.querySelectorAll(':scope > .gline')).toHaveLength(4);
    expect(card.lastElementChild?.className).toContain('gactions');
    // The gate stays in the modal.
    expect(text(card)).not.toContain('gate');
    // Open, its icon alone and named, leaves the card alone; the card opens the PR's modal, gate and all.
    const openLink = card.querySelector('.gactions a.open')!;
    expect([openLink.getAttribute('aria-label'), openLink.getAttribute('target'), text(openLink)]).toEqual(['Open', '_blank', '']);
    expect(openLink.querySelector('svg.openicon')).toBeTruthy();
    await click(g, openLink);
    expect(g.$('#overlay')!.className).not.toBe('open');
    await click(g, card);
    expect(text(g.$('#modalbox .pr-view-chips'))).toContain('waiting-approval');
  });

  it('chips what a badge that is not green says, offers Merge when green where it applies, and acks on open instead of an Ack button', async () => {
    const d = acceptanceFleet();
    const p = d.prs.find((x) => x.number === 41)!;
    Object.assign(p, { mine: true, badge: { ...p.badge, tone: 'bad', text: 'Conflicts' } });
    const other = d.prs.find((x) => x.number === 42)!;
    other.mine = false;
    d.attention = [{ kind: 'pr:conflict', key: p.key, lane: 'work', note: 'conflicts', ageSecs: 0, stateHash: 'h41' } as never];
    const g = await page({ ...d, focusToken: 'tok' }, '#prs');
    const card = (n: number) => g.$$('#prs .card').find((c) => text(c.querySelector('.gcontext')).includes(`#${n}`))!;
    expect([...card(41).querySelectorAll('.gstate .gchip')].map(text)).toEqual(['Open', 'conflicts']);
    // One main action, a big button with its icon; no Ack: opening the card acks it.
    expect([...card(41).querySelectorAll('.gactions button')].map(text)).toEqual(['Merge when green']);
    expect(card(41).querySelector('.gactions .btn-primary svg.acticon')).toBeTruthy();
    expect([...card(42).querySelectorAll('.gactions button')].map(text)).toEqual([]);
    expect([...card(42).querySelectorAll('.gactions a')].map((a) => a.getAttribute('aria-label'))).toEqual(['Open']);
    // ↗ Open sits at the bar's right on every card.
    expect(card(41).querySelector('.gactions')!.lastElementChild?.className).toContain('gopenbtn');
    // Merge when green asks the boat in one click, the repo's way, and a tap on the bar never opens the card.
    await click(
      g,
      [...card(41).querySelectorAll('.gactions button')].find((b) => text(b) === 'Merge when green'),
    );
    expect(g.$('#overlay')!.className).not.toBe('open');
    expect(g.$('#prs .prmerge.asking')).toBeNull();
    expect(JSON.parse(g.posts().at(-1)!.body)).toMatchObject({ kind: 'pr-merge', payload: { key: p.key } });
    // Opening the stack (page() opens it, as a click would) acked what it showed.
    const acks = () => g.posts().filter((r) => r.body.includes('pr-ack'));
    expect(acks().map((r) => JSON.parse(r.body))).toEqual([{ kind: 'pr-ack', payload: { items: [{ key: p.key, stateHash: 'h41' }] } }]);
    // Opening a PR with nothing to ack sends nothing.
    await click(g, card(42));
    expect(acks()).toHaveLength(1);
    g.window.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await g.settle();
    // This page's acks fail (no server), so #41 still shows its state: opening its card acks it.
    await click(g, card(41));
    expect(acks()).toHaveLength(2);
    expect(JSON.parse(acks()[1]!.body)).toEqual({ kind: 'pr-ack', payload: { items: [{ key: p.key, stateHash: 'h41' }] } });
  });

  it('gives every card button one size: 32px tall, 12px words, 6px apart, Open a 32px square', async () => {
    const d = acceptanceFleet();
    d.prs = d.prs.map((x) => ({ ...x, mine: true }));
    const g = await page({ ...d, focusToken: 'tok' }, '#prs');
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    const buttons = g.$$('#prs .card .gactions .btn');
    expect(buttons.length).toBeGreaterThan(2);
    for (const b of buttons) {
      expect(style(b).getPropertyValue('min-height'), b.className).toBe('32px');
      expect(style(b).getPropertyValue('font-size'), b.className).toBe('12px');
    }
    for (const bar of g.$$('#prs .card .gactions')) expect(style(bar).getPropertyValue('gap')).toBe('6px');
    for (const open of g.$$('#prs .card .gactions .btn-icon')) expect(style(open).getPropertyValue('min-width')).toBe('32px');
    // Open stays pushed to the bar's right, whatever the one size sets.
    for (const open of g.$$('#prs .card .gactions .gopenbtn')) expect(style(open).getPropertyValue('margin-left')).toBe('auto');
  });

  it("acks a card's PR from its Open icon too, and a stack when it opens", async () => {
    const d = acceptanceFleet();
    const p = d.prs.find((x) => x.number === 41)!;
    d.attention = [{ kind: 'pr:review', key: p.key, lane: 'work', note: 'review', ageSecs: 0, stateHash: 'h41' } as never];
    const g = await page({ ...d, focusToken: 'tok' }, '#prs', () => ({ status: 200, body: { ok: true, acked: [] } }));
    const stack = g.$('#prs .stackcard')!;
    const acks = () => g.posts().filter((r) => r.body.includes('pr-ack')).length;
    // page() opened the stack, as a click would: that acked it.
    expect(acks()).toBe(1);
    // Closing it acks nothing.
    await click(g, stack);
    expect(stack.getAttribute('aria-expanded')).toBe('false');
    expect(acks()).toBe(1);
    // Opening it again acks what it shows again (this page's acks mark nothing acked).
    await click(g, stack);
    expect(acks()).toBe(2);
    // Open on the stack card acks it as well, and leaves the stack as it was.
    await click(g, stack.querySelector(':scope > .gactions a.open'));
    expect(acks()).toBe(3);
    expect(stack.getAttribute('aria-expanded')).toBe('true');
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
    // Skip and Mute PR are in the menu beside the main action; Open stays on the bar.
    const bar = [...card(7).querySelectorAll('.gactions button, .gactions a')].map((b) => text(b) || b.getAttribute('aria-label'));
    expect(bar).toEqual(['Approve', 'More actions', 'Open draft']);
    await click(g, card(7).querySelector('.gactions .splitcaret'));
    expect(card(7).querySelector('.cmenulist')?.parentElement).toBe(card(7).querySelector('.split'));
    expect([...card(7).querySelectorAll('.cmenulist [role="menuitem"]')].map(text)).toEqual(['Skip', 'Mute PR']);
    expect(g.$('#overlay')!.className).not.toBe('open');
    expect(chips(8)).toEqual(['drafting']);
    expect(chips(9)).toEqual(['approved']);
    expect(chips(10)).toEqual(['changes requested']);
    expect(chips(11)).toEqual(['posted']);
    // No trap has a round that ran no job.
    expect(text(card(8).querySelector('.gcontext .gtext'))).toBe('acme/web · 60m ago · #8');
    const draft = card(7).querySelector('.gactions a')!;
    expect([draft.getAttribute('aria-label'), draft.getAttribute('href')]).toEqual([
      'Open draft',
      'https://github.com/acme/web/pull/7#pullrequestreview-1',
    ]);
    expect(card(8).className).toContain('gcard-edge gedge-warn');
    expect(card(8).querySelector('.gactions a')!.getAttribute('aria-label')).toBe('Open');
    expect(card(9).className).toContain('gcard-edge gedge-ok');
    expect(card(9).className).toContain('quiet');
    expect(card(9).querySelector('.split-menu-only')).toBeTruthy();
    expect([...card(9).querySelectorAll('.gactions button')].map((b) => text(b) || b.getAttribute('aria-label'))).toEqual(['More actions']);
    await click(g, card(9).querySelector('.gactions .splitmore'));
    expect([...card(9).querySelectorAll('.cmenulist [role="menuitem"]')].map(text)).toEqual(['Mute PR']);
    // Who asked and the reason are in the modal, not on the card.
    expect(text(card(7))).not.toContain('maya');
    // Sending a review verdict is one click; the card never opens.
    const approve = () => [...card(7).querySelectorAll('.gactions button')].find((b) => text(b) === 'Approve');
    await click(g, approve());
    expect(g.$('#overlay')!.className).not.toBe('open');
    const sends = () => g.posts().filter((p) => JSON.parse(p.body).kind !== 'review-seen');
    expect(sends().map((p) => JSON.parse(p.body))).toEqual([{ kind: 'review-approve', payload: { key: 'review:acme/web#7' } }]);
  });

  it('opens the PR view without acknowledgement, with who asked, the reason, the pending review and the actions', async () => {
    const r = review(9, { state: 'stale', reason: 'the head moved', staged: true });
    const g = await page({ ...emptyFleet(), focusToken: 'tok', reviews: [r] }, '#reviews', () => ({ status: 200, body: { ok: true } }));
    await click(g, g.$('#reviews .card'));
    expect(g.opened()).toEqual([]);
    expect(g.posts()).toEqual([]);
    const box = g.$('#modalbox')!;
    expect(text(box.querySelector('h2'))).toBe('pr 9');
    expect(text(box)).toContain('acme/web#9');
    expect(text(box)).toContain('the head moved');
    expect(text(box.querySelector('.rv-person'))).toContain('maya');
    expect(text(box.querySelector('.rv-staged'))).toBe('Open draft');
    // Its actions; the modal's close is a button too.
    expect(text(box.querySelector('.detail-actions'))).toContain('Redraft');
    await click(g, box.querySelector('.splitcaret'));
    expect([...box.querySelectorAll('[role=menuitem]')].map(text)).toEqual(['Dismiss', 'Mute PR']);
  });
});
