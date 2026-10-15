import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout, latestRound, observeReviewRequest, readReview, writeReview } from '@lobstah/core';
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

describe('the Reviews tab', () => {
  it('one row per item, the waiting count on the tab, and Post, Edit, Dismiss on a drafted round', async () => {
    const d = {
      ...emptyFleet(),
      focusToken: 'tok',
      reviews: [
        review(7, { state: 'drafted', body: 'Looks **right**.', comments: [{ path: 'src/a.ts', line: 12, body: 'Why not b()?' }] }),
        review(8, { requestedAt: ago(60) }),
        review(9, { state: 'posted', stands: false }),
      ],
    };
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, post: () => ({ status: 200, body: { ok: true } }) });
    open.push(g);
    await g.go('#reviews');
    expect(g.$('#tabs a[data-tab="reviews"] .tcount')?.textContent).toBe('2');
    const rows = g.$$('#reviews tr.rowhead');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('acme/web#8'), expect.stringContaining('acme/web#7'), expect.stringContaining('acme/web#9')]);
    (rows[1] as unknown as HTMLElement).click();
    await g.settle();
    const detail = g.$('#reviews .rv-detail')!;
    expect(detail.textContent).toContain('Looks right.');
    expect(detail.textContent).toContain('src/a.ts:12');
    const buttons = [...detail.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Post', 'Edit', 'Dismiss']);
    (detail.querySelector('button') as unknown as HTMLElement).click();
    await g.settle();
    const posted = g.posts().find((p) => p.url === '/requests')!;
    expect(posted.headers['x-lobstah-token']).toBe('tok');
    expect(JSON.parse(posted.body)).toEqual({ kind: 'review-post', payload: { key: 'review:acme/web#7' } });
  });

  it('a review lob opens the Reviews tab', () => {
    const [lob] = lobItems([{ kind: 'review', key: 'review:acme/web#7', stateHash: 'h', id: 'review:acme/web#7', lane: 'chore', verb: 'drafted', ageSecs: 1, note: 'acme/web#7 pr 7' }], { lobs: true });
    expect(lob).toMatchObject({ key: 'review:review:acme/web#7', label: 'review request', hash: '#reviews' });
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

  it('refuses every review kind without the page token', async () => {
    const { base } = await start();
    for (const kind of ['review-post', 'review-edit', 'review-dismiss', 'review-redraft']) {
      expect((await send(base, 'wrong', kind, { key: 'review:acme/web#7' })).status).toBe(403);
    }
  });

  it('dismisses, edits and refuses what the round cannot do', async () => {
    observeReviewRequest({
      pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' },
      round: { id: 'RRE_7', requestedAt: ago(60) },
    });
    const { base, token } = await start();
    const edit = await send(base, token, 'review-edit', { key: 'review:acme/web#7', body: 'x' });
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { reason: string }).reason).toContain('only a drafted or stale review can be edited');
    const item = readReview('review:acme/web#7')!;
    item.rounds[0]!.state = 'drafted';
    writeReview(item);
    expect((await send(base, token, 'review-edit', { key: 'review:acme/web#7', body: 'Edited.', comments: [] })).status).toBe(200);
    expect((await send(base, token, 'review-dismiss', { key: 'review:acme/web#7' })).status).toBe(200);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'dismissed', by: 'glass' });
    expect((await send(base, token, 'review-post', { key: 'review:acme/web#7' })).status).toBe(409);
    expect((await send(base, token, 'review-post', { key: 'not-a-review' })).status).toBe(400);
  });
});
