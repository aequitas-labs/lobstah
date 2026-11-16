import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, latestRound, loadConfig, observeReviewRequest, pendingIds, readReview, REVIEW_ROUND_STATES, writeReview, refreshReviewNotifications, reviewRoundDir } from '@lobstah/core';
import { REVIEW_DECISIONS } from '../../../test/review-decisions.js';
import { glassReviews } from '../src/reviews.js';
import type { GlassReview } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { serveGlass } from '../src/glass.js';
import { lobItems } from '../../../packages/glass-ui/src/glass-lobs.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, ago, emptyFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let open: GlassDom[] = [];
let server: Server | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-reviews-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

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
    requestedBy: 'dana',
    requestedAt: ago(3600),
    state: 'requested',
    stands: true,
    headSha: 'aaaaaaa1',
    prHeadSha: 'aaaaaaa1',
    ...over,
  };
}

const fleet = () => ({
  ...emptyFleet(),
  focusToken: 'tok',
  reviews: [review(7, { state: 'drafted', staged: true }), review(8, { requestedAt: ago(60) }), review(9, { state: 'stale', reason: 'the head moved' }), review(10, { state: 'posted', stands: false })],
});

/** Open a review card's modal: who asked, findings, the reason, the pending review and the actions are there. */
async function openCard(g: GlassDom, n: number) {
  (g.$(`#reviews [data-review="review:acme/web#${n}"]`) as unknown as HTMLElement).click();
  await g.settle();
  return g.$('#modalbox')!;
}

describe('the Reviews tab', () => {
  it.each(['cards', 'table'])('excludes the live #2919 withdrawn notification and marks every counted %s item until opened', async view => {
    const withdrawn = review(2919, { state: 'withdrawn', stands: false, title: 'Add the deterministic pricing aggregate node', notification: { kind: 'draft-ready', at: ago(30), text: 'Draft ready: #2919 Add the deterministic pricing aggregate node · request changes · 2 blocking' } });
    let rows = [withdrawn, review(7, { state: 'drafted', verdict: 'comment', notification: { kind: 'draft-ready', at: ago(30), text: 'Draft ready' } }), review(8, { state: 'failed' }), review(9, { state: 'stale' })];
    const snapshot = () => ({ ...fleet(), reviews: rows });
    const g = await loadGlass(GLASS_PAGE, snapshot(), {
      now: NOW, hash: '#reviews', prefs: { view },
      post: (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.kind === 'review-seen') {
          rows = rows.map(row => row.key === request.payload.key ? { ...row, seenAt: ago(0) } : row);
          g.serve(snapshot());
        }
        return { status: 200, body: { ok: true } };
      },
    }); open.push(g);
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('3');
    expect(g.$('.bbitem[href="#reviews"] .dbadge')?.textContent).toBe('3');
    expect(g.$$('#reviews [data-review-unread]')).toHaveLength(3);
    expect(g.$('#reviews [data-review="review:acme/web#2919"] [data-review-unread]')).toBeNull();
    expect(g.$('#reviews [data-review="review:acme/web#7"] [data-review-unread]')?.textContent).toContain('New draft');
    (g.$('#reviews [data-review="review:acme/web#7"]') as unknown as HTMLElement).click(); await g.settle();
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('2');
    (g.$('.detail-close') as unknown as HTMLElement).click(); await g.settle();
    expect(g.$$('#reviews [data-review-unread]')).toHaveLength(2);
    const reload = await loadGlass(GLASS_PAGE, snapshot(), { now: NOW, hash: '#reviews', prefs: { view } }); open.push(reload);
    expect(reload.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('2');
  });
  it.each(['cards', 'table'])('shows needs your call in %s until every decision has an answer', async view => {
    const r = review(7, { state: 'drafted', verdict: 'approve', decisions: REVIEW_DECISIONS });
    const g = await loadGlass(GLASS_PAGE, { ...fleet(), reviews: [r] }, { now: NOW, hash: '#reviews', prefs: { view } });
    open.push(g);
    expect(g.$('#reviews')?.textContent).toContain('needs your call');
    const button = g.$$('#reviews button').find(button => button.textContent?.includes('Approve'))!;
    expect(button.hasAttribute('disabled')).toBe(true);
    g.serve({ ...fleet(), reviews: [{ ...r, decisionAnswers: { 'rollout-owner': { optionId: 'product' }, 'existing-users': { text: 'Ask each user.' } } }] });
    await g.poll();
    expect(g.$('#reviews')?.textContent).not.toContain('needs your call');
    expect(g.$$('#reviews button').find(button => button.textContent?.includes('Approve'))?.hasAttribute('disabled')).toBe(false);
  });
  it.each(['card', 'keyboard', 'row'])('opening a review by %s acknowledges its lob and decrements only its badge', async (entry) => {
    const d = {
      ...fleet(),
      attention: [7, 8].map(n => ({
        kind: 'review' as const, key: `review:acme/web#${n}`, id: `review:acme/web#${n}`,
        lane: 'chore' as const, verb: 'ready', stateHash: `round-${n}`, ageSecs: 60,
        note: `Review ${n} is ready`, prUrl: `https://github.com/acme/web/pull/${n}`,
      })),
      reviews: [review(7, { state: 'drafted', staged: true }), review(8)],
    };
    const g = await loadGlass(GLASS_PAGE, d, {
      now: NOW, hash: '#reviews', prefs: { view: entry === 'row' ? 'table' : 'cards', lobs: true },
      post: (_url, init) => {
        const request = JSON.parse(init.body);
        return { status: 200, body: { ok: true, acked: request.payload.items?.map((item: { key: string; stateHash: string }) => ({ ...item, at: new Date(NOW).toISOString(), by: 'glass' })) } };
      },
    });
    open.push(g);
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('2');
    expect(g.$$('#lobs .lob')).toHaveLength(2);
    const card = g.$('[data-review="review:acme/web#7"]')!;
    if (entry === 'keyboard') card.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
    else (card as unknown as HTMLElement).click();
    await g.settle();
    const [ack] = g.posts();
    expect(ack!.headers['x-lobstah-token']).toBe('tok');
    expect(JSON.parse(ack!.body)).toEqual({ kind: 'attention-ack', payload: { items: [{ key: 'review:acme/web#7', stateHash: 'round-7' }] } });
    expect(g.posts()).toHaveLength(1);
    expect(g.$('#tabs [data-tab="reviews"] .dbadge')?.textContent).toBe('1');
    expect(g.$('[data-review="review:acme/web#7"]')?.classList.contains('seen')).toBe(true);
    expect(g.$$('#lobs .lob')).toHaveLength(1);
    expect(g.$('#lobs')?.textContent).toContain('Review 8 is ready');
    expect(g.window.location.hash).toBe('#pr/pr%3Aacme%2Fweb%237');
    expect(g.$('.detail-frame')?.textContent).toContain('Open draft');
  });

  it.each([['approve', 'Approve', 'review-approve'], ['request_changes', 'Request changes', 'review-request-changes'], ['comment', 'Publish comment', 'review-comment']] as const)('shows the %s action and sends only that explicit action', async (verdict, label, kind) => {
    const r = review(7, { state: 'drafted', verdict, needsYou: verdict === 'approve', summary: 'Reviewed summary', blocking: verdict === 'request_changes' ? [{ path: 'src/a.ts', line: 12, body: 'Race condition' }] : [] });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, { now: NOW, prefs: { view: 'cards' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g); await g.go('#reviews');
    if (verdict === 'approve') expect(g.$$('#reviews .gstate .gchip').map((c) => c.textContent)).toEqual(['● draft ready', 'needs you']);
    const box = await openCard(g, 7);
    expect(box.textContent).toContain(label);
    expect(box.textContent).toContain('Reviewed summary');
    if (verdict === 'request_changes') expect(box.textContent).toContain('src/a.ts:12');
    if (verdict === 'approve') expect(box.textContent).toContain('needs you');
    ([...box.querySelectorAll('button')].find(b => b.textContent === label) as unknown as HTMLElement).click();
    await g.settle();
    expect(g.posts().map(p => JSON.parse(p.body))).toContainEqual({ kind, payload: { key: r.key } });
    expect(g.opened()).toHaveLength(0);
  });

  it('posts a drafted verdict from the card in one click and shows its success message', async () => {
    const r = review(7, { state: 'drafted', staged: true, verdict: 'approve' });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, {
      now: NOW,
      prefs: { view: 'cards' },
      post: () => ({ status: 200, body: { ok: true } }),
    });
    open.push(g);
    await g.go('#reviews');
    const card = g.$('#reviews [data-review="review:acme/web#7"]')!;
    expect(card.textContent).not.toContain('Keep');
    expect(card.textContent).not.toContain('Post approval');
    const action = card.querySelector('.gactions button') as unknown as HTMLElement;
    action.click();
    await g.settle();
    expect(g.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'review-approve', payload: { key: r.key } });
    expect(g.$$('.toast-content').map((status) => status.textContent)).toContain('Approved #7');
  });

  it('legacy deep links open Reviews despite stored filters and leave the draft pending', async () => {
    const r = review(7, { state: 'drafted', verdict: 'approve', needsYou: true, seenAt: ago(10) });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, { now: NOW, prefs: { view: 'cards', repo: 'other', q: 'unrelated' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g); await g.go('#review-review%3Aacme%2Fweb%237');
    expect(g.$('#tabs a[data-tab="reviews"]')?.classList.contains('on')).toBe(true);
    expect(g.$('[data-review]')?.classList.contains('seen')).toBe(true);
    expect(g.$('#reviews')?.textContent).toContain('needs you');
    expect(g.posts()).toEqual([]);
    expect(g.$('#tabs a[data-tab="reviews"] .dbadge')).toBeNull();
  });

  it('puts mute in the card menu, keeps unmute on the bar, and links to a posted review', async () => {
    const post = () => ({ status: 200, body: { ok: true } });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [review(7), review(8, { state: 'posted', stands: false, postedAt: ago(60), postedReviewUrl: 'https://github.com/acme/web/pull/8#pullrequestreview-88' })] }, { now: NOW, prefs: { view: 'cards' }, post });
    open.push(g); await g.go('#reviews');
    const openCard = g.$('#reviews [data-review="review:acme/web#7"]')!;
    expect(openCard.querySelector('.gactions')?.textContent).not.toContain('Mute PR');
    (openCard.querySelector('.splitcaret') as unknown as HTMLElement).click(); await g.settle();
    const mute = [...openCard.querySelectorAll('.cmenulist [role="menuitem"]')].find(button => button.textContent === 'Mute PR') as unknown as HTMLElement;
    mute.click(); await g.settle();
    expect(g.posts().map(p => JSON.parse(p.body))).toContainEqual({ kind: 'review-mute', payload: { key: 'review:acme/web#7' } });
    expect(g.$$('.toast-content').map(status => status.textContent)).toContain('Muted');
    (openCard.querySelector('.splitcaret') as unknown as HTMLElement).click(); await g.settle();
    const skip = [...openCard.querySelectorAll('.cmenulist [role="menuitem"]')].find(button => button.textContent === 'Skip') as unknown as HTMLElement;
    skip.click(); await g.settle();
    expect(g.posts().map(p => JSON.parse(p.body))).toContainEqual({ kind: 'review-skip', payload: { key: 'review:acme/web#7' } });
    expect(g.$$('.toast-content').map(status => status.textContent)).toContain('Dismissed');
    const closedCard = g.$('#reviews [data-review="review:acme/web#8"]')!;
    expect(closedCard.querySelector('.split-menu-only')).toBeTruthy();
    (closedCard.querySelector('.splitmore') as unknown as HTMLElement).click(); await g.settle();
    expect([...closedCard.querySelectorAll('.cmenulist [role="menuitem"]')].map(button => button.textContent)).toEqual(['Mute PR']);
    const posted = g.$('#reviews a[href="https://github.com/acme/web/pull/8#pullrequestreview-88"]');
    expect(posted?.textContent).toContain('Posted');

    const muted = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [review(7, { mutedAt: ago(30) })] }, { now: NOW, prefs: { view: 'cards' }, post });
    open.push(muted); await muted.go('#reviews');
    const unmute = muted.$$('#reviews button').find(button => button.textContent === 'Unmute') as unknown as HTMLElement;
    expect(unmute).toBeTruthy();
    expect(unmute.querySelector('svg.acticon[aria-hidden="true"]')).toBeTruthy();
    expect(muted.$('#reviews .gactions .badge')).toBeNull();
    unmute.click(); await muted.settle();
    expect(muted.posts().map(p => JSON.parse(p.body))).toContainEqual({ kind: 'review-unmute', payload: { key: 'review:acme/web#7' } });
  });
  it('shows every round state, cached author avatars, and the pending review link', async () => {
    const d = { ...fleet(), reviews: REVIEW_ROUND_STATES.map((state, i) => review(20 + i, {
      state, stands: ['requested', 'drafted', 'stale', 'failed'].includes(state),
      asker: 'dana', askerName: 'Dana Developer', askerAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4',
      automatic: true, reviewUrl: `linear://review/acme/web/pull/${20 + i}`,
      ...(state === 'drafted' ? { staged: true, stagedReviewUrl: 'https://github.com/acme/web/pull/22#pullrequestreview-99' } : {}),
    })) };
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, prefs: { view: 'cards' } });
    open.push(g);
    await g.go('#reviews');
    // A drafted round's chip says its draft is ready; every other state says itself.
    const chips = g.$$('#reviews .gstate .gchip').map((b) => b.textContent?.replace(/^● /, ''));
    for (const state of REVIEW_ROUND_STATES) expect(chips).toContain(state === 'drafted' ? 'draft ready' : state);
    // The drafted round's card links its pending review; the others open the review tool.
    const drafted = 20 + REVIEW_ROUND_STATES.indexOf('drafted');
    const draftLink = g.$(`#reviews [data-review="review:acme/web#${drafted}"] .gactions a`)!;
    expect([draftLink.getAttribute('aria-label'), draftLink.getAttribute('href')]).toEqual(['Open draft', 'https://github.com/acme/web/pull/22#pullrequestreview-99']);
    const firstOpen = g.$('#reviews .card .gactions a') as unknown as HTMLElement;
    expect(firstOpen.getAttribute('href')).toContain('linear://review/');
    // The author's name and avatar are in the modal.
    const box = await openCard(g, drafted);
    expect(box.querySelector('.rv-person img')?.getAttribute('src')).toContain('avatars.githubusercontent.com/u/7');
    expect(box.querySelector('.rv-person')?.textContent).toContain('Dana Developer');
    expect(box.querySelector('.rv-staged')?.getAttribute('href')).toContain('#pullrequestreview-99');
    (box.querySelector('.splitcaret') as unknown as HTMLElement).click();
    await g.settle();
    expect([...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dismiss')?.getAttribute('title')).toContain('does not decline the review on GitHub');
    // An avatar that can't load (offline, or a page that blocks it) shows the asker's initials.
    box.querySelector('.rv-person img')!.dispatchEvent(new g.window.Event('error'));
    await g.settle();
    expect(g.$('#modalbox .rv-person .rv-initials')?.textContent).toBe('DD');
  });

  it('shows the setup command when disabled and review settings as text when enabled', async () => {
    const disabled = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviewSetup: { enabled: false, mode: 'notify', running: false } }, { now: NOW });
    open.push(disabled);
    await disabled.go('#reviews');
    expect(disabled.$('#reviews')?.textContent).toContain('lobstah setup reviews');
    const g = await loadGlass(GLASS_PAGE, { ...fleet(), reviewSetup: { enabled: true, mode: 'notify', identity: 'chris', running: true } }, { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$$('#reviews button').some((b) => b.textContent === 'Review (draft)')).toBe(false);
    expect(g.$('#reviews .rv-controls')?.textContent).toContain('Review mode · default: Notify');
    expect(g.$('#reviews .rv-controls')?.textContent).toContain('Publish: off');
    expect(g.$$('#reviews .rv-controls input, #reviews .rv-controls select, #reviews .rv-controls button')).toEqual([]);
    expect(g.posts().some(p => JSON.parse(p.body).kind === 'review-mode')).toBe(false);
  });

  it('shows grounds and per-repo auto-post choices under Configuration', async () => {
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviewSetup: { enabled: true, mode: 'auto-draft', autoPostApprove: 'ask', autoPostRequestChanges: 'ask', running: true, perRepo: { web: { mode: 'auto-draft', publish: false, autoPostApprove: 'auto-post', autoPostRequestChanges: 'ask', overridden: true } } } }, {
      now: NOW,
      settings: { file: '~/.lobstah/config.toml', versions: { rows: [], match: true, text: 'Versions match' }, grounds: [], repos: [], sections: [] },
    });
    open.push(g); await g.go('#settings');
    expect(g.$('#settings')?.textContent).toContain('Review posting');
    expect(g.$('#settings')?.textContent).toContain('Default');
    expect(g.$('#settings')?.textContent).toContain('Approve: ask · Request changes: ask');
    expect(g.$('#settings')?.textContent).toContain('Approve: auto-post · Request changes: ask');
  });

  it('a workflow request names the PR author and uses the configured review tool', () => {
    observeReviewRequest({
      pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', authorName: 'Dana Developer', authorAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4', headSha: 'aaaaaaa1' },
      round: { id: 'RRE_7', requestedAt: ago(60), requestedBy: 'github-actions' },
    });
    expect(glassReviews({ 'acme/web': 'linear-app' })[0]).toMatchObject({ asker: 'dana', askerName: 'Dana Developer', automatic: true, reviewUrl: 'linear://review/acme/web/pull/7' });
  });
  it.each(['cards', 'table'])('renders the earlier human requester after a bot re-request in %s', async (view) => {
    const pr = { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' };
    observeReviewRequest({ pr, round: { id: 'human', requestedAt: ago(120), requestedBy: 'maya', requestedByName: 'Maya Maintainer', requestedByAvatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4' } });
    observeReviewRequest({ pr, round: { id: 'bot', requestedAt: ago(60), requestedBy: 'github-actions', requestedAutomatically: true } });
    const page = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: glassReviews() }, { now: NOW, hash: '#reviews', prefs: { view } });
    open.push(page);
    const person = page.$(view === 'cards' ? '#reviews .gavatar' : '#reviews .rv-person');
    const label = view === 'cards' ? person?.getAttribute('title') : person?.textContent;
    expect(label).toContain('Maya Maintainer');
    expect(label).not.toContain('github-actions');
    expect(person?.querySelector('img')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/9?v=4');
    if (view === 'table') expect(person?.querySelector('.badge')?.getAttribute('title')).toBe('A bot re-requested this review');
  });
  it('the repo filter scopes the settings chip and row labels use each repo policy', async () => {
    const g = await loadGlass(GLASS_PAGE, {
      ...fleet(), repos: ['web'],
      reviews: [review(8, { mode: 'on-demand', publish: true })],
      reviewSetup: { enabled: true, mode: 'notify', publish: false, running: true, perRepo: { web: { mode: 'on-demand', publish: true, autoPostApprove: 'ask', autoPostRequestChanges: 'ask', overridden: true } } },
    }, { now: NOW, prefs: { repo: 'web' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$('#reviews')?.textContent).toContain('Review mode · web');
    expect([...g.$$('#f-repo option')].map(o => o.textContent)).toContain('web');
    expect(g.$('#reviews')?.textContent).toContain('Review (publish)');
    expect(g.$('#reviews .rv-controls')?.textContent).toContain('Review mode · web: On-demand');
    expect(g.$('#reviews .rv-controls')?.textContent).toContain('Publish: on');
    expect(g.$$('#reviews .rv-controls input, #reviews .rv-controls select, #reviews .rv-controls button')).toEqual([]);
    expect(g.posts().some(p => JSON.parse(p.body).kind === 'review-mode')).toBe(false);
  });
  it('rows open the PR view; explicit actions send guarded requests', async () => {
    const g = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$('#tabs a[data-tab="reviews"]')?.textContent).toContain('Reviews');
    const rows = g.$$('#reviews tr.rowhead');
    expect(rows.map((r) => r.querySelector('td')?.textContent?.trim())).toEqual(['acme/web#8', 'acme/web#7', 'acme/web#9', 'acme/web#10']);
    expect(rows[1]!.textContent).toContain('drafted');
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Publish comment', 'Mute this PR', 'Dismiss']);
    expect([...rows[2]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Redraft', 'Mute this PR', 'Dismiss']);
    expect([...rows[3]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Mute this PR']);
    (rows[1] as unknown as HTMLElement).click();
    await g.settle();
    expect(g.window.location.hash).toBe('#pr/pr%3Aacme%2Fweb%237');
    expect(g.posts().map(post => JSON.parse(post.body))).toEqual([{ kind: 'review-seen', payload: { key: 'review:acme/web#7' } }]);
    (g.$('.detail-close') as unknown as HTMLElement).click();
    await g.settle();
    (rows[2]!.querySelector('button') as unknown as HTMLElement).click();
    await g.settle();
    const sent = g.posts().find((p) => JSON.parse(p.body).kind === 'review-draft')!;
    expect(sent.headers['x-lobstah-token']).toBe('tok');
    expect(JSON.parse(sent.body)).toEqual({ kind: 'review-draft', payload: { key: 'review:acme/web#9' } });
  });

  it('card mode shows the Reviews inbox and On Deck has no review cards', async () => {
    const g = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, prefs: { view: 'cards' } });
    open.push(g);
    await g.go('#reviews');
    expect(g.$$('#reviews .card b').map((b) => b.textContent)).toEqual(['pr 8', 'pr 7', 'pr 9', 'pr 10']);
    await g.go('#deck');
    expect(g.$$('#deck section h2').map(h => h.textContent)).not.toContain('reviews →');
  });

  it('On Deck has no reviews block when none waits', async () => {
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: [review(10, { state: 'posted', stands: false })] }, { now: NOW });
    open.push(g);
    expect(g.$$('#deck section h2').map((h) => h.textContent)).not.toContain('reviews →');
  });

  it('a review lob opens the PR view without acknowledging it', () => {
    const [lob] = lobItems(
      [{ kind: 'review', key: 'review:acme/web#7', stateHash: 'h', id: 'review:acme/web#7', lane: 'chore', verb: 'drafted', note: 'acme/web#7 pr 7', prUrl: 'https://github.com/acme/web/pull/7', reviewUrl: 'https://app.graphite.com/github/pr/acme/web/7' }],
      { lobs: true },
    );
    expect(lob).toMatchObject({ key: 'review:review:acme/web#7', label: 'review request', hash: '#pr/pr%3Aacme%2Fweb%237' });
  });
});

describe('review requests on /requests', () => {
  async function start(): Promise<{ base: string; token: string }> {
    server = serveGlass(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = ((await (await fetch(`${base}/data`)).json()) as { focusToken: string }).focusToken;
    return { base, token };
  }
  const send = (base: string, token: string, kind: string, payload: unknown) =>
    fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token }, body: JSON.stringify({ kind, payload }) });

  it('refuses the review kinds without the page token, and has no post or edit', async () => {
    const { base, token } = await start();
    for (const kind of ['review-dismiss', 'review-skip', 'review-seen', 'review-approve', 'review-request-changes', 'review-comment', 'review-decision-answer', 'review-new', 'review-redraft', 'review-draft', 'review-mode']) expect((await send(base, 'wrong', kind, { key: 'review:acme/web#7' })).status).toBe(403);
    for (const kind of ['review-post', 'review-edit']) expect((await send(base, token, kind, { key: 'review:acme/web#7' })).status).toBe(400);
  });

  it('refuses review settings writes with a valid page token and preserves config', async () => {
    const configFile = path.join(home, 'config.toml');
    fs.writeFileSync(configFile, '[reviews]\nenabled = true\nmode = "notify"\n[repos.web]\npath = "/w"\n');
    const before = fs.readFileSync(configFile, 'utf8');
    const { base, token } = await start();
    for (const payload of [{ mode: 'on-demand' }, { mode: 'auto-review', publish: true, repo: 'web' }]) {
      const response = await send(base, token, 'review-mode', payload);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, reason: 'Settings are read-only in glass.' });
    }
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    expect(loadConfig().reviews.mode).toBe('notify');
  });

  it('saves per-round answers through the guarded API and returns them after reload', async () => {
    const key = 'review:acme/web#7';
    const item = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaa' }, round: { id: 'round1', requestedAt: ago(60) } }).item;
    const draftedAt = ago(30);
    Object.assign(item.rounds[0]!, { state: 'drafted', draftedAt, decisions: REVIEW_DECISIONS }); writeReview(item);
    const dir = reviewRoundDir(key, 'round1')!; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.md'), 'Code looks right.');
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [], decisions: REVIEW_DECISIONS }));
    const { base, token } = await start();
    const payload = { key, roundId: 'round1', headSha: 'aaa', draftedAt, decisionId: 'rollout-owner', answer: { optionId: 'product' } };
    expect((await send(base, token, 'review-decision-answer', payload)).status).toBe(200);
    expect((await send(base, token, 'review-decision-answer', { ...payload, decisionId: 'existing-users', answer: { text: 'Ask each user.' } })).status).toBe(200);
    expect(glassReviews()[0]).toMatchObject({ roundId: 'round1', decisions: REVIEW_DECISIONS, decisionAnswers: { 'rollout-owner': { optionId: 'product' }, 'existing-users': { text: 'Ask each user.' } } });
    expect((await send(base, token, 'review-decision-answer', { ...payload, headSha: 'old' })).status).toBe(409);
    expect((await send(base, token, 'review-decision-answer', { ...payload, answer: { optionId: 'bad' } })).status).toBe(409);
  });

  it('New review refuses an unconfigured identity without changing the skipped history', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "on-demand"\n');
    const key = 'review:acme/web#7';
    const item = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaa' }, round: { id: 'round1', requestedAt: ago(60) } }).item;
    item.rounds[0]!.state = 'dismissed'; writeReview(item);
    const { base, token } = await start();
    expect((await send(base, token, 'review-new', { key })).status).toBe(409);
    expect(readReview(key)!.rounds.map(round => round.state)).toEqual(['dismissed']);
  });

  it('the Draft action follows the configured on-demand mode', async () => {
    process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
    try {
      const configFile = path.join(home, 'config.toml');
      const config = '[reviews]\nenabled = true\nmode = "notify"\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\n[repos.web]\npath = "/w"\n';
      fs.writeFileSync(configFile, config);
      observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' }, round: { id: 'RRE_7', requestedAt: ago(60) } });
      const { base, token } = await start();
      expect((await send(base, token, 'review-draft', { key: 'review:acme/web#7' })).status).toBe(409);
      fs.writeFileSync(configFile, config.replace('mode = "notify"', 'mode = "on-demand"'));
      expect((await send(base, token, 'review-draft', { key: 'review:acme/web#7' })).status).toBe(200);
      expect(pendingIds('chore')).toHaveLength(1);
      expect(latestRound(readReview('review:acme/web#7')!)?.state).toBe('drafting');
    } finally { delete process.env.LOBSTAH_TEST_REVIEW_TOKEN; }
  });

  it('dismisses an unstaged round, and refuses what the round cannot do', async () => {
    observeReviewRequest({
      pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' },
      round: { id: 'RRE_7', requestedAt: ago(60) },
    });
    const { base, token } = await start();
    const redraft = await send(base, token, 'review-redraft', { key: 'review:acme/web#7' });
    expect(redraft.status).toBe(409);
    expect(((await redraft.json()) as { reason: string }).reason).toContain('only a drafted, stale or failed round re-drafts');
    expect((await send(base, token, 'review-dismiss', { key: 'review:acme/web#7' })).status).toBe(200);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'dismissed', by: 'glass' });
    expect((await send(base, token, 'review-dismiss', { key: 'not-a-review' })).status).toBe(400);
  });

  it('mutes a PR through future requests and resumes when unmuted', async () => {
    const key = 'review:acme/web#7';
    observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' }, round: { id: 'RRE_7', requestedAt: ago(60) } });
    const { base, token } = await start();
    expect((await send(base, token, 'review-mute', { key })).status).toBe(200);
    expect(readReview(key)?.mutedAt).toEqual(expect.any(String));
    expect(observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'bbbbbbb2' }, round: { id: 'RRE_8', requestedAt: ago(30) } }).opened).toBe(false);
    expect((await send(base, token, 'review-unmute', { key })).status).toBe(200);
    expect(readReview(key)?.mutedAt).toBeUndefined();
    expect(observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'bbbbbbb2' }, round: { id: 'RRE_8', requestedAt: ago(30) } }).opened).toBe(true);
  });

  it('Skip acknowledges a published notification without changing or deleting the sent review', async () => {
    const key = 'review:acme/web#7';
    const item = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' }, round: { id: 'r', requestedAt: ago(60) } }).item;
    Object.assign(item.rounds[0]!, { state: 'posted', by: 'auto', verdict: 'comment', postedAt: ago(10) }); writeReview(item); refreshReviewNotifications();
    const { base, token } = await start();
    expect((await send(base, token, 'review-skip', { key })).status).toBe(200);
    expect(latestRound(readReview(key)!)).toMatchObject({ state: 'posted', acknowledgedAt: expect.any(String) });
    expect(latestRound(readReview(key)!)?.notification).toBeUndefined();
    expect(refreshReviewNotifications()).toEqual([]);
  });

  it('seen preserves the ready notification and needs-you; Skip acknowledges and clears both', async () => {
    const key = 'review:acme/web#7';
    const item = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' }, round: { id: 'r', requestedAt: ago(60) } }).item;
    Object.assign(item.rounds[0]!, { state: 'drafted', verdict: 'approve', draftedAt: ago(10) }); writeReview(item); refreshReviewNotifications();
    const { base, token } = await start();
    expect((await send(base, token, 'review-seen', { key })).status).toBe(200);
    expect(latestRound(readReview(key)!)).toMatchObject({ needsYou: true, notification: { kind: 'needs-you' }, seenAt: expect.any(String) });
    const seen = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: glassReviews() }, { now: Date.now(), hash: '#reviews' }); open.push(seen);
    expect(seen.$('#tabs [data-tab="reviews"] .dbadge')).toBeNull();
    expect((await send(base, token, 'review-skip', { key })).status).toBe(200);
    expect(latestRound(readReview(key)!)).toMatchObject({ state: 'dismissed', acknowledgedAt: expect.any(String) });
    expect(latestRound(readReview(key)!)?.notification).toBeUndefined();
    expect(latestRound(readReview(key)!)?.needsYou).toBeUndefined();
    expect(refreshReviewNotifications()).toEqual([]);
  });
});
