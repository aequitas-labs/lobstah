import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { enqueue, claimNext, requestCancel, complete, ensureLayout, latestRound, muteReview, observeReviewRequest, readReview, reviewRoundDir, writeReview } from '@lobstah/core';
import { dismissReviewRound, postReview, redraftReviewRound, stageReview } from '../src/reviews-post.js';
import type { FetchLike } from '../src/reviews-post.js';
import { draftReviews, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-post-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "auto-review"\n');
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

function enableAutoPost(verdict: 'approve' | 'request_changes'): void {
  const key = verdict === 'approve' ? 'autoPostApprove' : 'autoPostRequestChanges';
  fs.writeFileSync(path.join(home, 'config.toml'), `[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-draft"\n${key} = "auto-post"\n`);
  const item = readReview(KEY)!;
  item.rounds[0]![key] = 'auto-post';
  item.rounds[0]!.verdict = verdict;
  writeReview(item);
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * A fake GitHub for one PR's reviews: the reviews already there, a create
 * that answers with id 99 (or fails with `postStatus`), a submit of a pending
 * review, one review's state by id, and a delete.
 */
function github(calls: Call[], existing: Array<{ id: number; body: string; state?: string }> = [], postStatus = 200, head = 'aaaaaaa1'): FetchLike {
  return async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    const one = /\/reviews\/(\d+)$/.exec(url);
    if (init.method === 'GET' && /\/user$/.test(url)) return new Response(JSON.stringify({ login: 'chris' }), { status: 200 });
    if (init.method === 'GET' && one) {
      const r = existing.find((x) => x.id === Number(one[1]));
      return r ? new Response(JSON.stringify(r), { status: 200 }) : new Response('Not Found', { status: 404 });
    }
    if (init.method === 'GET' && /\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ head: { sha: head }, state: 'open' }));
    if (init.method === 'GET') return new Response(JSON.stringify(existing), { status: 200 });
    if (init.method === 'DELETE') return new Response(JSON.stringify({}), { status: 200 });
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
          comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: `Why not b()?\n\n${MARKER}` }],
        },
      },
    ]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', postedReviewId: '99', by: 'cli' });
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('already posted') });
  });

  it.each(['approve', 'comment', 'request_changes'] as const)('publishes %s only through its allowed path', async verdict => {
    drafted();
    const blocking = verdict === 'request_changes' ? [{ path: 'src/a.ts', line: 14, body: 'This loses writes.' }] : [];
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict, blocking }));
    if (verdict !== 'comment') enableAutoPost(verdict);
    const calls: Call[] = [];
    const result = await postReview(KEY, { by: 'auto', token: tok, fetch: github(calls) });
    if (verdict === 'comment') {
      expect(result).toMatchObject({ posted: false, why: expect.stringContaining('publishing is off') });
      expect(posts(calls)).toEqual([]);
      expect(await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls) })).toMatchObject({ posted: true });
      expect(posts(calls)[0]?.body).toMatchObject({ event: 'COMMENT' });
    } else {
      expect(result).toMatchObject({ posted: true });
      expect(posts(calls)[0]?.body?.event).toBe(verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
      if (blocking.length) expect(posts(calls)[0]?.body?.comments).toContainEqual(expect.objectContaining({ path: 'src/a.ts', line: 14, body: expect.stringContaining('This loses writes.') }));
    }
  });

  it('refuses an action that no longer matches the verdict', async () => {
    drafted(); const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'glass', event: 'APPROVE', token: tok, fetch: github(calls) })).toMatchObject({ posted: false });
    expect(await postReview(KEY, { by: 'glass', event: 'REQUEST_CHANGES', token: tok, fetch: github(calls) })).toMatchObject({ posted: false });
    expect(calls).toEqual([]);
  });

  it('two Posts of one round at once make one POST', async () => {
    drafted();
    const calls: Call[] = [];
    const f = github(calls);
    const both = await Promise.all([postReview(KEY, { by: 'cli', token: tok, fetch: f }), postReview(KEY, { by: 'cli', token: tok, fetch: f })]);
    expect(posts(calls)).toHaveLength(1);
    expect(both.filter((o) => o.posted)).toHaveLength(1);
  });

  it('refuses a stale draft even with the old explicit stale flag', async () => {
    drafted('stale');
    const calls: Call[] = [];
    for (const stale of [false, true]) expect(await postReview(KEY, { by: 'cli', stale, token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('re-draft it') });
    expect(calls).toEqual([]);
  });

  it('checks the live head immediately before publishing, refusing a push after search', async () => {
    drafted();
    enableAutoPost('request_changes');
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'src/a.ts', line: 14, body: 'Race' }] }));
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'auto', token: tok, fetch: github(calls, [], 200, 'bbbbbbb2') })).toMatchObject({ posted: false, why: expect.stringContaining('head changed') });
    expect(posts(calls)).toEqual([]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'stale' });
    expect(fs.existsSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'posted.json'))).toBe(false);
  });

  it('a review already carrying the round marker is recorded, not posted again', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls, [{ id: 41, body: `fine\n\n${MARKER}` }]) });
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
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'identity = "chris"', 'work = "off"', 'mode = "auto-draft"', `post = "${post}"`, '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'].join('\n'));

  it.each(['approve', 'comment', 'request_changes'] as const)('auto-review %s notifies only at completion, once, with a Reviews row link', async verdict => {
    config('auto'); drafted();
    const blocking = verdict === 'request_changes' ? [{ path: 'a.ts', line: 2, body: 'Race' }] : [];
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict, blocking }));
    const notices: Array<{ key: string; kind: string; text: string; url: string }> = []; const calls: Call[] = [];
    for (let i = 0; i < 3; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls), notify: e => notices.push(e) });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('needs-you');
    expect(notices[0]?.url).toContain('/#review-review%3Aacme%2Fweb%237');
    expect(posts(calls).map(c => c.body?.event)).toEqual([undefined]);
    expect(latestRound(readReview(KEY)!)?.needsYou).toBe(true);
  });

  it.each([
    ['approve', 'autoPostApprove', 'APPROVE'],
    ['request_changes', 'autoPostRequestChanges', 'REQUEST_CHANGES'],
  ] as const)('auto-posts %s only when its setting is enabled', async (verdict, setting, event) => {
    config('draft');
    fs.appendFileSync(path.join(home, 'config.toml'), `\n[repos.web.reviews]\nmode = "auto-draft"\n${setting} = "auto-post"\n`);
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { autoPostApprove: 'ask', autoPostRequestChanges: 'ask', [setting]: 'auto-post' });
    writeReview(item);
    const blocking = verdict === 'request_changes' ? [{ path: 'a.ts', line: 2, body: 'Race' }] : [];
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict, blocking }));
    const calls: Call[] = [];
    for (let i = 0; i < 2; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls).map((call) => call.body?.event)).toEqual([event]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', by: 'auto', postedReviewId: '99' });
  });

  it('refuses auto-post when the GitHub token is not the configured reviewer', async () => {
    drafted();
    enableAutoPost('approve');
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "alex"\nmode = "auto-draft"\nautoPostApprove = "auto-post"\n');
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'auto', token: tok, fetch: github(calls) });
    expect(out).toMatchObject({ posted: false, why: expect.stringContaining('not alex') });
    expect(posts(calls)).toEqual([]);
  });

  it('refuses an automatic post after the PR is muted', async () => {
    drafted();
    enableAutoPost('approve');
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    muteReview(KEY);
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'auto', token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('PR is muted') });
    expect(posts(calls)).toEqual([]);
  });

  it('post = "draft" stages the draft as a pending review, once, and never posts it', async () => {
    config('draft');
    drafted();
    const calls: Call[] = [];
    for (let i = 0; i < 3; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls)).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/web/pulls/7/reviews',
        body: { commit_id: 'aaaaaaa1', body: `Looks right.\n\n${MARKER}`, comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: `Why not b()?\n\n${MARKER}` }] },
      },
    ]);
    expect(posts(calls)[0]!.body).not.toHaveProperty('event');
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', staged: { reviewId: '99' } });
  });

  it('never auto-posts comments-only drafts', async () => {
    config('auto');
    drafted();
    const calls: Call[] = [];
    for (let i = 0; i < 2; i++) await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls).map((c) => c.body!.event)).toEqual([undefined]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', needsYou: true });
  });

  it.each(['auto-draft', 'auto-review'])('%s follows the repo override and never sends an approval or change request', async (mode) => {
    config('draft');
    fs.appendFileSync(path.join(home, 'config.toml'), `\n[repos.web.reviews]\nmode = "${mode}"\n`);
    drafted();
    const calls: Call[] = [];
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls).map(c => c.body?.event)).toEqual([undefined]);
    expect(latestRound(readReview(KEY)!)?.state).toBe('drafted');
  });

  it('a job started in draft mode stays pending after switching to publish', async () => {
    config('auto');
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { publish: false, draftOnly: true });
    writeReview(item);
    const calls: Call[] = [];
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls).map(c => c.body?.event)).toEqual([undefined]);
  });

  it('auto-post never posts a stale draft, and does not retry a failed post', async () => {
    config('draft');
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[repos.web.reviews]\nmode = "auto-draft"\nautoPostRequestChanges = "auto-post"\n');
    drafted('stale');
    const item = readReview(KEY)!;
    item.rounds[0]!.autoPostApprove = 'ask';
    item.rounds[0]!.autoPostRequestChanges = 'auto-post';
    writeReview(item);
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 2, body: 'Race' }] }));
    const calls: Call[] = [];
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(calls).toEqual([]);

    const failedItem = readReview(KEY)!;
    failedItem.rounds[0]!.state = 'drafted';
    writeReview(failedItem);
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls, [], 422) });
    await reviewsLoop('chris', tok, () => {}, { run: search, fetch: github(calls) });
    expect(posts(calls)).toHaveLength(1);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', reason: expect.stringContaining('post failed') });
  });
});

describe('staged reviews', () => {
  function staged(state: 'drafted' | 'stale' = 'drafted'): void {
    drafted(state);
    const item = readReview(KEY)!;
    item.rounds[0]!.staged = { reviewId: '77', at: '2026-10-15T10:00:00Z' };
    writeReview(item);
  }
  const gone: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 0, nodes: [] } } }) });
  const config = () =>
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'work = "off"', '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'].join('\n'));

  it('post sends the staged pending review as COMMENT', async () => {
    staged();
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: true });
    expect(posts(calls)).toEqual([{ method: 'POST', url: 'https://api.github.com/repos/acme/web/pulls/7/reviews/77/events', body: { event: 'COMMENT', body: `Looks right.\n\n${MARKER}` } }]);
  });

  it('when the request goes, a review sent from the tool reads posted; a still-pending one withdraws; a deleted one dismisses', async () => {
    config();
    staged();
    await reviewsLoop('chris', tok, () => {}, { run: gone, fetch: github([], [{ id: 77, body: MARKER, state: 'APPROVED' }]) });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', by: 'review tool', postedReviewId: '77' });

    fs.rmSync(path.join(home, 'reviews'), { recursive: true });
    staged();
    await reviewsLoop('chris', tok, () => {}, { run: gone, fetch: github([], [{ id: 77, body: MARKER, state: 'PENDING' }]) });
    expect(latestRound(readReview(KEY)!)!.state).toBe('withdrawn');

    fs.rmSync(path.join(home, 'reviews'), { recursive: true });
    staged();
    await reviewsLoop('chris', tok, () => {}, { run: gone, fetch: github([], []) });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'dismissed', by: 'review tool' });
  });

  it('dismiss deletes the pending review; a review already sent is not deleted', async () => {
    staged();
    const calls: Call[] = [];
    expect(await dismissReviewRound(KEY, 'glass', { token: tok, fetch: github(calls, [{ id: 77, body: MARKER, state: 'PENDING' }]) })).toBeUndefined();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/web/pulls/7/reviews/77']);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'dismissed', by: 'glass' });
    expect(latestRound(readReview(KEY)!)!.staged).toBeUndefined();

    fs.rmSync(path.join(home, 'reviews'), { recursive: true });
    staged();
    const sent: Call[] = [];
    expect(await dismissReviewRound(KEY, 'glass', { token: tok, fetch: github(sent, [{ id: 77, body: MARKER, state: 'COMMENTED' }]) })).toContain('already sent');
    expect(sent.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(latestRound(readReview(KEY)!)!.state).toBe('posted');
  });

  it('re-drafting a stale round deletes its pending review first', async () => {
    staged('stale');
    const calls: Call[] = [];
    expect(await redraftReviewRound(KEY, { token: tok, fetch: github(calls, [{ id: 77, body: MARKER, state: 'PENDING' }]) })).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'requested' });
    expect(latestRound(readReview(KEY)!)!.staged).toBeUndefined();
  });
});

describe('post-time review policy', () => {
  it.each(['notify', 'on-demand'])('refuses an in-flight publishing round after switching to %s', async mode => {
    drafted();
    const item = readReview(KEY)!; Object.assign(item.rounds[0]!, { autoPostApprove: 'auto-post', autoPostRequestChanges: 'ask' }); writeReview(item);
    fs.writeFileSync(path.join(home, 'config.toml'), `[reviews]\nenabled = true\nidentity = "chris"\nmode = "${mode}"\nautoPostApprove = "auto-post"\n`);
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'auto', token: tok, fetch: github(calls) })).toMatchObject({ posted: false });
    expect(posts(calls)).toEqual([]);
  });

  it('rechecks policy after the live-head request, before submitting a staged review', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-review"\nautoPostApprove = "auto-post"\n');
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { autoPostApprove: 'auto-post', autoPostRequestChanges: 'ask', verdict: 'approve', staged: { reviewId: '50', at: new Date().toISOString() } }); writeReview(item);
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    const calls: Call[] = [];
    const request = github(calls);
    const fetcher: FetchLike = async (url, init) => {
      const result = await request(url, init);
      if (init.method === 'GET' && /\/pulls\/7$/.test(url)) fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-draft"\nautoPostApprove = "ask"\n');
      return result;
    };
    expect(await postReview(KEY, { by: 'auto', token: tok, fetch: fetcher })).toMatchObject({ posted: false });
    expect(posts(calls)).toEqual([]);
    expect(fs.existsSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'posted.json'))).toBe(false);
  });
});

it.each(['auto', 'glass'] as const)('refuses %s publishing after cancellation, including a finalized dispatch', async by => {
  drafted();
  enqueue({ id: 'd1', repo: 'web', brief: 'review' }, 'chore'); claimNext('chore');
  requestCancel('d1', 'chore'); complete('d1', 'chore');
  const calls: Call[] = [];
  expect(await postReview(KEY, { by, token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('cancelled') });
  expect(posts(calls)).toEqual([]);
  draftReviews('chris');
  expect(latestRound(readReview(KEY)!)?.state).toBe('failed');
});

it('refuses cancellation that arrives during the live-head request', async () => {
  drafted();
  enableAutoPost('approve');
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
  enqueue({ id: 'd1', repo: 'web', brief: 'review' }, 'chore'); claimNext('chore');
  const calls: Call[] = [];
  const request = github(calls);
  const fetcher: FetchLike = async (url, init) => {
    const result = await request(url, init);
    if (init.method === 'GET' && /\/pulls\/7$/.test(url)) requestCancel('d1', 'chore');
    return result;
  };
  expect(await postReview(KEY, { by: 'auto', token: tok, fetch: fetcher })).toMatchObject({ posted: false, why: expect.stringContaining('cancelled') });
  expect(posts(calls)).toEqual([]);
});

it('cancellation while checking pending reviews prevents staging a new draft', async () => {
  drafted();
  enqueue({ id: 'd1', repo: 'web', brief: 'review' }, 'chore'); claimNext('chore');
  const calls: Call[] = [];
  const request = github(calls);
  const fetcher: FetchLike = async (url, init) => {
    const result = await request(url, init);
    if (init.method === 'GET') requestCancel('d1', 'chore');
    return result;
  };
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: false, why: expect.stringContaining('cancelled') });
  expect(posts(calls)).toEqual([]);
});
