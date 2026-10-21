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
import { lobItems } from '../src/glass-lobs.js';
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

describe('the Reviews tab', () => {
  it.each([['approve', 'Approve', 'review-approve'], ['request_changes', 'Request changes', 'review-request-changes'], ['comment', 'Publish comment', 'review-comment']] as const)('shows the %s action and sends only that explicit action', async (verdict, label, kind) => {
    const r = review(7, { state: 'drafted', verdict, needsYou: verdict === 'approve', summary: 'Reviewed summary', blocking: verdict === 'request_changes' ? [{ path: 'src/a.ts', line: 12, body: 'Race condition' }] : [] });
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', reviews: [r] }, { now: NOW, prefs: { view: 'cards' }, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g); await g.go('#reviews');
    expect(g.$('#reviews')?.textContent).toContain(label);
    expect(g.$('#reviews')?.textContent).toContain('Reviewed summary');
    if (verdict === 'request_changes') expect(g.$('#reviews')?.textContent).toContain('src/a.ts:12');
    if (verdict === 'approve') expect(g.$('#reviews')?.textContent).toContain('needs you');
    (g.$$('#reviews button').find(b => b.textContent === label) as unknown as HTMLElement).click();
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
    for (const state of REVIEW_ROUND_STATES) expect(g.$$('#reviews .top .badge').map((b) => b.textContent)).toContain(state);
    expect(g.$('#reviews .rv-person img')?.getAttribute('src')).toContain('avatars.githubusercontent.com/u/7');
    expect(g.$('#reviews .rv-person')?.textContent).toContain('Dana Developer');
    expect(g.$('#reviews .rv-person')?.textContent).toContain('automatic');
    expect(g.$('#reviews .rv-staged')?.getAttribute('href')).toContain('#pullrequestreview-99');
    const first = g.$('#reviews .card') as unknown as HTMLElement;
    first.click();
    await g.settle();
    expect(g.opened().at(-1)?.[0]).toContain('linear://review/');
    expect(g.$$('#reviews button').find((b) => b.textContent === 'Skip')?.getAttribute('title')).toContain('does not decline the review on GitHub');
  });

  it('offers the setup command when disabled, and notify/on-demand/auto modes without TOML editing', async () => {
    const disabled = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviewSetup: { enabled: false, mode: 'notify', running: false } }, { now: NOW });
    open.push(disabled);
    await disabled.go('#reviews');
    expect(disabled.$('#reviews')?.textContent).toContain('lobstah setup reviews');
    const g = await loadGlass(GLASS_PAGE, { ...fleet(), reviewSetup: { enabled: true, mode: 'notify', identity: 'chris', running: true } }, { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$$('#reviews button').some((b) => b.textContent === 'Review (draft)')).toBe(false);
    const select = g.$('#reviews select') as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['notify', 'on-demand', 'auto-draft', 'auto-review']);
    select.value = 'on-demand';
    select.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
    await g.settle();
    expect(g.posts().some((p) => p.body === JSON.stringify({ kind: 'review-mode', payload: { mode: 'on-demand', publish: false } }))).toBe(true);
  });

  it('a workflow request names the PR author and uses the configured review tool', () => {
    observeReviewRequest({
      pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', authorName: 'Dana Developer', authorAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4', headSha: 'aaaaaaa1' },
      round: { id: 'RRE_7', requestedAt: ago(60), requestedBy: 'github-actions' },
    });
    expect(glassReviews({ 'acme/web': 'linear-app' })[0]).toMatchObject({ asker: 'dana', askerName: 'Dana Developer', automatic: true, reviewUrl: 'linear://review/acme/web/pull/7' });
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
    const toggle = g.$('#reviews input[aria-label="Publish reviews"]') as unknown as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
    await g.settle();
    expect(g.posts().some(p => p.body === JSON.stringify({ kind: 'review-mode', payload: { mode: 'on-demand', publish: false, repo: 'web' } }))).toBe(true);
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

  it('the mode switch writes config and the Draft action starts a requested round only on demand', async () => {
    process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "notify"\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\n[repos.web]\npath = "/w"\n');
      observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' }, round: { id: 'RRE_7', requestedAt: ago(60) } });
      const { base, token } = await start();
      expect((await send(base, token, 'review-draft', { key: 'review:acme/web#7' })).status).toBe(409);
      expect((await send(base, token, 'review-mode', { mode: 'on-demand' })).status).toBe(200);
      expect(loadConfig().reviews.mode).toBe('on-demand');
      expect((await send(base, token, 'review-draft', { key: 'review:acme/web#7' })).status).toBe(200);
      expect(pendingIds('chore')).toHaveLength(1);
      expect(latestRound(readReview('review:acme/web#7')!)?.state).toBe('drafting');
      expect((await send(base, token, 'review-mode', { mode: 'post' })).status).toBe(400);
      expect((await send(base, token, 'review-mode', { mode: 'auto-review', repo: 'web', publish: true })).status).toBe(200);
      expect(loadConfig().reviews.perRepo.web).toMatchObject({ mode: 'auto-review', publish: true });
      expect(loadConfig().reviews.mode).toBe('on-demand');
      expect((await send(base, token, 'review-mode', { mode: 'notify', repo: 'missing' })).status).toBe(400);
      expect((await send(base, token, 'review-mode', { mode: 'notify', publish: 'yes' })).status).toBe(400);
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
