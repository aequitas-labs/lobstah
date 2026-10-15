import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, latestRound, observeReviewRequest, readReview } from '@lobstah/core';
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
  it('rows open the PR in its review tool; only dismiss and re-draft act here; no count on the tab', async () => {
    const g = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$('#tabs a[data-tab="reviews"]')?.textContent).toBe('Reviews');
    const rows = g.$$('#reviews tr.rowhead');
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual(['acme/web#8', 'acme/web#7', 'acme/web#9', 'acme/web#10']);
    expect(rows[1]!.textContent).toContain('ready to send');
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['dismiss']);
    expect([...rows[2]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['re-draft', 'dismiss']);
    expect(rows[3]!.querySelectorAll('button')).toHaveLength(0);
    (rows[1] as unknown as HTMLElement).click();
    await g.settle();
    expect(g.opened().at(-1)?.[0]).toBe('https://app.graphite.com/github/pr/acme/web/7');
    (rows[2]!.querySelector('button') as unknown as HTMLElement).click();
    await g.settle();
    const sent = g.posts().find((p) => p.url === '/requests')!;
    expect(sent.headers['x-lobstah-token']).toBe('tok');
    expect(JSON.parse(sent.body)).toEqual({ kind: 'review-redraft', payload: { key: 'review:acme/web#9' } });
  });

  it('card mode shows the same reviews as cards, and On Deck lists the ones waiting on you', async () => {
    const g = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, prefs: { view: 'cards' } });
    open.push(g);
    await g.go('#reviews');
    expect(g.$$('#reviews .card b').map((b) => b.textContent)).toEqual(['pr 8', 'pr 7', 'pr 9', 'pr 10']);
    await g.go('#deck');
    const deck = g.$$('#deck section').find((s) => s.querySelector('h2')?.textContent?.startsWith('reviews'))!;
    expect(deck).toBeTruthy();
    expect([...deck.querySelectorAll('a.card')].map((a) => a.getAttribute('href'))).toEqual([
      'https://app.graphite.com/github/pr/acme/web/8',
      'https://app.graphite.com/github/pr/acme/web/7',
      'https://app.graphite.com/github/pr/acme/web/9',
    ]);
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
    for (const kind of ['review-dismiss', 'review-redraft']) expect((await send(base, 'wrong', kind, { key: 'review:acme/web#7' })).status).toBe(403);
    for (const kind of ['review-post', 'review-edit']) expect((await send(base, token, kind, { key: 'review:acme/web#7' })).status).toBe(400);
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
});
