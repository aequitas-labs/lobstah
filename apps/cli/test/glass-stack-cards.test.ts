import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot, GlassPr, GlassReview } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, emptyFleet } from './fixtures/glass-snapshots.js';
import { stackMembers, stackSummary, stackUpdatedAt } from '../../../packages/glass-ui/ui/components/prs.js';
import { githubAvatarUrl, personLabel } from '../../../packages/glass-ui/ui/components/card.js';

/**
 * Stacks on the PRs tab are one card each (prs.ts StackCard): a summary, the
 * repo and the last change, opening downward to every member's own PR card,
 * the bottom of the stack first. Every PR, review and stack card has an
 * avatar chip at its top right, named only on hover.
 */

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

async function page(d: GlassFullSnapshot, hash: string): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view: 'cards' } });
  pages.push(g);
  return g;
}

/** The acceptance fleet's stack of #41, #42 and #43, each authored by dana. */
function fleet(): GlassFullSnapshot {
  const d = acceptanceFleet();
  d.prs = d.prs.map((p) => ({ ...p, author: 'dana' }));
  return d;
}

const pr = (number: number, over: Partial<GlassPr> = {}): GlassPr => ({ ...acceptanceFleet().prs[0]!, number, key: `pr:acme/web#${number}`, ...over });
const badge = (tone: GlassPr['badge']['tone']) => ({ ...acceptanceFleet().prs[0]!.badge, tone });

describe('a stack, as its card summarizes it', () => {
  it('lists its members bottom first, as its numbers run', () => {
    expect(stackMembers({ numbers: [41, 42, 43] }, [pr(43), pr(41), pr(42)]).map((p) => p.number)).toEqual([41, 42, 43]);
  });

  it('says ready to merge, how many fail, how many of its open PRs are green, or that it merged', () => {
    const open = (tone: GlassPr['badge']['tone']) => pr(1, { state: 'OPEN', badge: badge(tone) });
    expect(stackSummary({ readiness: { id: 's', url: '', ready: 3, total: 3, allReady: true, text: '', state: '' } }, [open('ok'), open('ok')])).toEqual({ text: 'ready to merge', tone: 'ok' });
    expect(stackSummary({}, [open('ok'), open('bad'), open('warn')])).toEqual({ text: '1 failing', tone: 'bad' });
    expect(stackSummary({}, [open('ok'), open('ok'), open('warn')])).toEqual({ text: '2 of 3 green', tone: 'warn' });
    expect(stackSummary({}, [open('ok'), pr(2, { state: 'MERGED' })])).toEqual({ text: '1 of 1 green', tone: 'ok' });
    expect(stackSummary({}, [pr(1, { state: 'MERGED' }), pr(2, { state: 'MERGED' })])).toEqual({ text: 'merged', tone: 'dim' });
  });

  it('was last updated at its newest change', () => {
    expect(stackUpdatedAt([pr(1, { updatedAt: ago(30 * MIN) }), pr(2, { updatedAt: ago(5 * MIN) }), pr(3, { updatedAt: ago(60 * MIN) })])).toBe(ago(5 * MIN));
  });
});

describe('a stack card on the PRs tab', () => {
  it('is one closed card with its summary, size, repo and last update, and no PR rows', async () => {
    const g = await page(fleet(), '#prs');
    const stack = g.$('#prs .stackcard')!;
    expect(stack.getAttribute('aria-expanded')).toBe('false');
    expect(stack.querySelector('.stackmembers')).toBeNull();
    expect([...stack.querySelectorAll('.gstate .gchip')].map(text)[1]).toBe('3 PRs');
    expect(text(stack.querySelector('.gcontext'))).toMatch(/^web · updated \S+ ago$/);
    expect(text(stack)).not.toMatch(/#4[12]\b|next/);
  });

  it('opens downward to every member card, bottom first, closes on a second click, and stays open across a poll', async () => {
    const g = await page(fleet(), '#prs');
    const stack = () => g.$('#prs .stackcard')!;
    (stack() as HTMLElement).click();
    await g.settle();
    expect(stack().getAttribute('aria-expanded')).toBe('true');
    const members = [...stack().querySelectorAll('.stackmembers .card')].map((c) => /#\d+/.exec(text(c.querySelector('.gcontext')))?.[0]);
    expect(members).toEqual(['#41', '#42', '#43']);
    await g.poll();
    expect(stack().querySelectorAll('.stackmembers .card')).toHaveLength(3);
    // A member card opens its PR, and leaves the stack open.
    (stack().querySelector('.stackmembers .card') as HTMLElement).click();
    await g.settle();
    expect(g.$('#modalbox')).toBeTruthy();
    expect(stack().getAttribute('aria-expanded')).toBe('true');
    g.window.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await g.settle();
    (stack() as HTMLElement).click();
    await g.settle();
    expect(stack().getAttribute('aria-expanded')).toBe('false');
    expect(stack().querySelector('.stackmembers')).toBeNull();
  });

  it('keeps a lone PR an ordinary PR card', async () => {
    const d = fleet();
    const lone = { ...d.prs[0]!, key: 'pr:acme/web#50', url: 'https://github.com/acme/web/pull/50', number: 50, title: 'A lone PR', stackId: 'pr:acme/web#50', position: 0 };
    d.prs.push(lone);
    d.stacks.push({ id: 'pr:acme/web#50', floor: 'main', repo: 'web', numbers: [50], open: true, nextNumber: 50, behind: 0 });
    const g = await page(d, '#prs');
    expect(g.$$('#prs .stackcard')).toHaveLength(1);
    const card = g.$$('#prs .card:not(.stackcard)').find((c) => text(c.querySelector('.gtitle')) === 'A lone PR');
    expect(card).toBeTruthy();
  });
});

describe('the avatar chip', () => {
  it("shows a PR's author at its card's top right, named only on hover", async () => {
    const g = await page(fleet(), '#prs');
    const stack = g.$('#prs .stackcard')!;
    const chip = stack.querySelector('.gtop .gavatar')!;
    expect(chip.getAttribute('title')).toBe('author: dana');
    expect(chip.getAttribute('aria-label')).toBe('author: dana');
    expect(chip.querySelector('img')!.getAttribute('src')).toBe(githubAvatarUrl('dana'));
    expect(text(stack)).not.toContain('dana');
    (stack as HTMLElement).click();
    await g.settle();
    for (const member of g.$$('#prs .stackmembers .card')) expect(member.querySelector('.gtop .gavatar')!.getAttribute('title')).toBe('author: dana');
  });

  it("shows a review's asker with their name on hover, and initials for a login with no avatar", async () => {
    const review = (n: number, over: Partial<GlassReview>): GlassReview => ({
      key: `review:acme/web#${n}`, url: `https://github.com/acme/web/pull/${n}`, reviewUrl: `https://github.com/acme/web/pull/${n}`, repo: 'acme/web', number: n,
      title: `pr ${n}`, author: 'dana', repoKey: 'web', requestedAt: ago(60 * MIN), state: 'requested', stands: true, headSha: 'aaaaaaa1', prHeadSha: 'aaaaaaa1', ...over,
    });
    const d = { ...emptyFleet(), reviews: [
      review(1, { asker: 'maya', askerName: 'Maya Lin', askerAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4', requestedBy: 'maya' }),
      review(2, { asker: 'renovate[bot]', requestedBy: 'renovate[bot]' }),
    ] };
    const g = await page(d, '#reviews');
    const chip = (n: number) => g.$(`#reviews [data-review="review:acme/web#${n}"] .gtop .gavatar`)!;
    expect(chip(1).getAttribute('title')).toBe('requested by: maya (Maya Lin)');
    expect(chip(1).querySelector('img')!.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1?v=4');
    expect(chip(2).querySelector('img')).toBeNull();
    expect(text(chip(2))).toBe('R');
    expect(text(g.$('#reviews [data-review="review:acme/web#1"]'))).not.toContain('Maya');
  });

  it('labels a person by role and login, then their name when it differs', () => {
    expect(personLabel({ login: 'dana', role: 'author' })).toBe('author: dana');
    expect(personLabel({ login: 'maya', name: 'Maya Lin', role: 'requested by' })).toBe('requested by: maya (Maya Lin)');
    expect(githubAvatarUrl('renovate[bot]')).toBeUndefined();
  });
});
