import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, latestRound, observeReviewRequest, readReview, reviewRoundDir, writeReview } from '@lobstah/core';
import { postReview } from '../src/reviews-post.js';
import type { FetchLike } from '../src/reviews-post.js';
import { reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-post-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const KEY = 'review:acme/web#7';
const MARKER = '<!-- lobstah:review RRE_7 -->';
const tok = () => 'token';

/** A drafted round of acme/web#7 at head aaaaaaa1. */
function drafted(state: 'drafted' | 'stale' = 'drafted'): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' },
    round: { id: 'RRE_7', requestedAt: '2026-10-15T09:00:00Z', requestedBy: 'dana' },
  });
  const dir = reviewRoundDir(KEY, 'RRE_7')!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), 'Looks right.\n');
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([{ path: 'src/a.ts', line: 12, body: 'Why not b()?' }]));
  const item = readReview(KEY)!;
  Object.assign(item.rounds[0]!, { state, dispatch: 'd1' });
  writeReview(item);
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** A fake GitHub: the PR's existing reviews, and a POST that answers with id 99 (or fails with `postStatus`). */
function github(calls: Call[], existing: Array<{ id: number; body: string }> = [], postStatus = 200): FetchLike {
  return async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (init.method === 'GET') return new Response(JSON.stringify(existing), { status: 200 });
    // Let a second, concurrent caller run while this one waits on GitHub.
    await new Promise((r) => setTimeout(r, 5));
    return postStatus === 200 ? new Response(JSON.stringify({ id: 99 }), { status: 200 }) : new Response('Unprocessable: line not in diff', { status: postStatus });
  };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

describe('postReview', () => {
  it('posts a comment-only review at the drafted head, marked with its round', async () => {
    drafted();
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toEqual({ posted: true, reviewId: '99', by: 'cli' });
    expect(posts(calls)).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/web/pulls/7/reviews',
        body: {
          commit_id: 'aaaaaaa1',
          event: 'COMMENT',
          body: `Looks right.\n\n${MARKER}`,
          comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Why not b()?' }],
        },
      },
    ]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', postedReviewId: '99', by: 'cli' });
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('already posted') });
  });

  it('two Posts of one round at once make one POST', async () => {
    drafted();
    const calls: Call[] = [];
    const f = github(calls);
    const both = await Promise.all([postReview(KEY, { by: 'glass', token: tok, fetch: f }), postReview(KEY, { by: 'glass', token: tok, fetch: f })]);
    expect(posts(calls)).toHaveLength(1);
    expect(both.filter((o) => o.posted)).toHaveLength(1);
  });

  it('a stale draft posts only with stale, and says the PR moved', async () => {
    drafted('stale');
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('re-draft it') });
    expect(calls).toEqual([]);
    await postReview(KEY, { by: 'cli', stale: true, token: tok, fetch: github(calls) });
    expect(posts(calls)[0]!.body!.body).toBe(`Looks right.\n\n_Drafted at aaaaaaa; the PR has moved since._\n\n${MARKER}`);
  });

  it('a review already carrying the round marker is recorded, not posted again', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', token: tok, fetch: github(calls, [{ id: 41, body: `fine\n\n${MARKER}` }]) });
    expect(out).toEqual({ posted: true, reviewId: '41', by: 'another boat' });
    expect(posts(calls)).toEqual([]);
    expect(latestRound(readReview(KEY)!)!.state).toBe('posted');
  });

  it('a failed POST frees the round to post again and keeps the reason', async () => {
    drafted();
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls, [], 422) })).toMatchObject({ posted: false, why: expect.stringContaining('422') });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', reason: expect.stringContaining('post failed') });
    expect(fs.existsSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'posted.json'))).toBe(false);
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: true });
  });
});

describe('posting from the reviews loop', () => {
  // issueCount 1 with no nodes: a truncated search, which withdraws nothing, so the draft stays open.
  const search: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [] } } }) });
  const config = (post: string) =>
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'work = "off"', `post = "${post}"`, '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'].join('\n'));

  it('post = "draft" never posts, across cycles', async () => {
    config('draft');
    drafted();
    const calls: Call[] = [];
    for (let i = 0; i < 3; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(calls).toEqual([]);
    expect(latestRound(readReview(KEY)!)!.state).toBe('drafted');
  });

  it('post = "auto" posts a fresh draft once, as COMMENT', async () => {
    config('auto');
    drafted();
    const calls: Call[] = [];
    for (let i = 0; i < 2; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls).map((c) => c.body!.event)).toEqual(['COMMENT']);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', by: 'auto' });
  });

  it('post = "auto" never posts a stale draft, and does not retry a failed post', async () => {
    config('auto');
    drafted('stale');
    const calls: Call[] = [];
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(calls).toEqual([]);

    const item = readReview(KEY)!;
    item.rounds[0]!.state = 'drafted';
    writeReview(item);
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls, [], 422) });
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls)).toHaveLength(1);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', reason: expect.stringContaining('post failed') });
  });
});
