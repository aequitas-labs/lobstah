import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, latestRound, loadConfig, observeReviewRequest, pendingIds, readReview, REVIEW_ROUND_STATES, writeReview, refreshReviewNotifications } from '@lobstah/core';
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
  it.each([['approve', 'Approve', 'review-approve'], ['request_changes', 'Request changes', 'review-request-changes'], ['comment', 'Publish comment', 'review-comment']] as const)('shows the %s action and sends only that explicit action', async (verdict, label, kind) => {
    const r = review(7, { state: 'drafted', verdict, needsYou: verdict === 'approve', summary: 'Reviewed summary', blocking: verdict === 'request_changes' ? [{ path: 'src/a.ts', line: 12, body: 'Race condition' }] : [] });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, { now: NOW, prefs: { view: 'cards' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g); await g.go('#reviews');
    if (verdict === 'approve') expect(g.$$('#reviews .gstate .gchip').map((c) => c.textContent)).toEqual(['draft ready', 'needs you']);
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

  it('deep links open Reviews despite stored filters, mark the target seen, and keep needs-you', async () => {
    const r = review(7, { state: 'drafted', verdict: 'approve', needsYou: true, seenAt: ago(10) });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, { now: NOW, prefs: { view: 'cards', repo: 'other', q: 'unrelated' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g); await g.go('#review-review%3Aacme%2Fweb%237');
    expect(g.$('#tabs a[data-tab="reviews"]')?.classList.contains('on')).toBe(true);
    expect(g.$('[data-review]')?.classList.contains('seen')).toBe(true);
    expect(g.$('#reviews')?.textContent).toContain('needs you');
    expect(g.posts().map(p => JSON.parse(p.body))).toContainEqual({ kind: 'review-seen', payload: { key: r.key } });
    expect(g.$('#tabs a[data-tab="reviews"] .dbadge')?.textContent).toBe('1');
  });
  it('shows every round state, cached requester avatars, automatic attribution, and the pending review link', async () => {
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
    const chips = g.$$('#reviews .gstate .gchip').map((b) => b.textContent);
    for (const state of REVIEW_ROUND_STATES) expect(chips).toContain(state === 'drafted' ? 'draft ready' : state);
    // The drafted round's card links its pending review; the others open the review tool.
    const drafted = 20 + REVIEW_ROUND_STATES.indexOf('drafted');
    const draftLink = g.$(`#reviews [data-review="review:acme/web#${drafted}"] .gactions a`)!;
    expect([draftLink.getAttribute('aria-label'), draftLink.getAttribute('href')]).toEqual(['Open draft', 'https://github.com/acme/web/pull/22#pullrequestreview-99']);
    const firstOpen = g.$('#reviews .card .gactions a') as unknown as HTMLElement;
    expect(firstOpen.getAttribute('href')).toContain('linear://review/');
    // Who asked, with the avatar, is in the modal.
    const box = await openCard(g, drafted);
    expect(box.querySelector('.rv-person img')?.getAttribute('src')).toContain('avatars.githubusercontent.com/u/7');
    expect(box.querySelector('.rv-person')?.textContent).toContain('Dana Developer');
    expect(box.querySelector('.rv-person')?.textContent).toContain('automatic');
    expect(box.querySelector('.rv-staged')?.getAttribute('href')).toContain('#pullrequestreview-99');
    expect([...box.querySelectorAll('button')].find((b) => b.textContent === 'Skip')?.getAttribute('title')).toContain('does not decline the review on GitHub');
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
    if (view === 'cards') await openCard(page, 7);
    expect(page.$('.rv-person')?.textContent).toContain('Maya Maintainer');
    expect(page.$('.rv-person')?.textContent).not.toContain('github-actions');
    expect(page.$('.rv-person img')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/9?v=4');
    expect(page.$('.rv-person .badge')?.getAttribute('title')).toBe('A bot re-requested this review');
  });
  it('the repo filter scopes the settings chip and row labels use each repo policy', async () => {
    const g = await loadGlass(GLASS_PAGE, {
      ...fleet(), repos: ['web'],
      reviews: [review(8, { mode: 'on-demand', publish: true })],
      reviewSetup: { enabled: true, mode: 'notify', publish: false, running: true, perRepo: { web: { mode: 'on-demand', publish: true, overridden: true } } },
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
  it('rows open the review tool as seen; explicit actions send guarded requests', async () => {
    const g = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$('#tabs a[data-tab="reviews"]')?.textContent).toContain('Reviews');
    const rows = g.$$('#reviews tr.rowhead');
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual(['acme/web#8', 'acme/web#7', 'acme/web#9', 'acme/web#10']);
    expect(rows[1]!.textContent).toContain('drafted');
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Publish comment', 'Skip']);
    expect([...rows[2]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Redraft', 'Skip']);
    expect(rows[3]!.querySelectorAll('button')).toHaveLength(0);
    (rows[1] as unknown as HTMLElement).click();
    await g.settle();
    expect(g.opened().at(-1)?.[0]).toBe('https://app.graphite.com/github/pr/acme/web/7');
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

  it('a review lob opens the PR in its review tool', () => {
    const [lob] = lobItems(
      [{ kind: 'review', key: 'review:acme/web#7', stateHash: 'h', id: 'review:acme/web#7', lane: 'chore', verb: 'drafted', note: 'acme/web#7 pr 7', prUrl: 'https://github.com/acme/web/pull/7', reviewUrl: 'https://app.graphite.com/github/pr/acme/web/7' }],
      { lobs: true },
    );
    expect(lob).toMatchObject({ key: 'review:review:acme/web#7', label: 'review request', href: 'https://app.graphite.com/github/pr/acme/web/7' });
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
    for (const kind of ['review-dismiss', 'review-skip', 'review-seen', 'review-approve', 'review-request-changes', 'review-comment', 'review-redraft', 'review-draft', 'review-mode']) expect((await send(base, 'wrong', kind, { key: 'review:acme/web#7' })).status).toBe(403);
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
    expect(((await redraft.json()) as { reason: string }).reason).toContain('only a stale or failed round re-drafts');
    expect((await send(base, token, 'review-dismiss', { key: 'review:acme/web#7' })).status).toBe(200);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'dismissed', by: 'glass' });
    expect((await send(base, token, 'review-dismiss', { key: 'not-a-review' })).status).toBe(400);
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
    expect((await send(base, token, 'review-skip', { key })).status).toBe(200);
    expect(latestRound(readReview(key)!)).toMatchObject({ state: 'dismissed', acknowledgedAt: expect.any(String) });
    expect(latestRound(readReview(key)!)?.notification).toBeUndefined();
    expect(latestRound(readReview(key)!)?.needsYou).toBeUndefined();
    expect(refreshReviewNotifications()).toEqual([]);
  });
});
