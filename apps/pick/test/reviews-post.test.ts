import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerReviewDecision, cancelQueued, enqueue, claimNext, requestCancel, complete, ensureLayout, latestRound, muteReview, observeReviewRequest, readReview, reviewRoundDir, writeReview } from '@lobstah/core';
import * as net from 'node:net';
import { dismissReviewRound, fetchFailureCause, GITHUB_UNREACHABLE, postReview, redraftReviewRound, reviewFailureLogText, stageReview } from '../src/reviews-post.js';
import type { FetchLike } from '../src/reviews-post.js';
import { draftReviews, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { REVIEW_DECISIONS } from '../../../test/review-decisions.js';

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
  Object.assign(item.rounds[0]!, { state, dispatch: 'd1', draftedAt: '2026-11-16T12:00:00Z' });
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

/** Save real per-round answers through the same function as Glass. */
function answerCalls(): void {
  const r = latestRound(readReview(KEY)!)!;
  const draft = { roundId: r.id, headSha: r.headSha, draftedAt: r.draftedAt! };
  expect(answerReviewDecision(KEY, draft, 'rollout-owner', { optionId: 'product' })).toBeUndefined();
  expect(answerReviewDecision(KEY, draft, 'existing-users', { text: 'Ask each user before migrating.' })).toBeUndefined();
}

describe('equivalent-head approvals', () => {
  it.each(['post', 'stage'] as const)('%s an anchor-free approval on the observed equivalent head', async action => {
    drafted();
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'review.md'), '');
    fs.writeFileSync(path.join(dir, 'comments.json'), '[]');
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    const item = readReview(KEY)!;
    Object.assign(item.pr, { headSha: 'bbbbbbb2', diffId: 'same-patch' });
    Object.assign(item.rounds[0]!, { diffId: 'same-patch', verdict: 'approve' });
    writeReview(item);
    const calls: Call[] = [];
    if (action === 'post') expect((await postReview(KEY, { by: 'glass', event: 'APPROVE', token: tok, fetch: github(calls, [], 200, 'bbbbbbb2') })).posted).toBe(true);
    else expect((await stageReview(KEY, { token: tok, fetch: github(calls, [], 200, 'bbbbbbb2') })).staged).toBe(true);
    expect(posts(calls)[0]!.body!.commit_id).toBe('bbbbbbb2');
  });

  it('does not reuse inline anchors on an equivalent head', async () => {
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.pr, { headSha: 'bbbbbbb2', diffId: 'same-patch' });
    item.rounds[0]!.diffId = 'same-patch';
    writeReview(item);
    const calls: Call[] = [];
    expect((await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).posted).toBe(false);
    expect((await stageReview(KEY, { token: tok, fetch: github(calls) })).staged).toBe(false);
    expect(posts(calls)).toEqual([]);
  });
});

describe('publishable findings', () => {
  it.each(['post', 'stage'] as const)('%s merges paraphrased finding ids but keeps different points on the same line', async action => {
    drafted();
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'review.md'), 'Draft only; nothing was posted to GitHub.\n\nFix the retry race.');
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([
      { path: 'a.ts', line: 98, findingId: 'retry-race', body: 'Two callers can send the same request.' },
      { path: 'a.ts', line: 98, findingId: 'account-scope', body: 'This query can read another account.' },
      { path: 'a.ts', line: 99, side: 'LEFT', findingId: 'retry-race', body: 'The removed guard prevented duplicate requests.' },
    ]));
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [
      { path: 'a.ts', line: 98, findingId: 'retry-race', body: 'Concurrent retries duplicate the request.' },
      { path: 'a.ts', line: 99, findingId: 'retry-race', body: 'Guard concurrent retries.' },
    ] }));
    const calls: Call[] = [];
    if (action === 'post') expect((await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).posted).toBe(true);
    else expect((await stageReview(KEY, { token: tok, fetch: github(calls) })).staged).toBe(true);
    const sent = posts(calls)[0]!.body!;
    const comments = sent.comments as Array<{ body: string }>;
    expect(comments).toHaveLength(4);
    expect(comments.filter(comment => comment.body.includes('**Blocking:**'))).toHaveLength(2);
    expect(comments.some(comment => comment.body.includes('another account'))).toBe(true);
    expect(comments.some(comment => comment.body.includes('Two callers'))).toBe(false);
    expect(sent.body).not.toContain('Draft only');
    expect(sent.body).toContain('Fix the retry race.');
  });

  it('deduplicates old drafts with matching issue titles and retains separate titles', async () => {
    drafted();
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([
      { path: 'a.ts', line: 98, body: '**Bound concurrent retries before sending**\nTwo callers can send the same request.' },
      { path: 'a.ts', line: 98, body: '**Scope the account**\nAnother account can be read.' },
      { path: 'a.ts', line: 98, body: '**Race condition**\nThe queue loses wakeups.' },
    ]));
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [
      { path: 'a.ts', line: 98, body: '**Bound concurrent retries before sending**\nConcurrent retries duplicate requests.' },
      { path: 'a.ts', line: 98, body: '**Race condition**\nThe counter can become negative.' },
    ] }));
    const calls: Call[] = [];
    await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) });
    expect(posts(calls)[0]!.body!.comments).toHaveLength(4);
  });
});

describe('review decision posting gate', () => {
  it.each(['approve', 'comment', 'request_changes'] as const)('blocks %s until every call is answered, then includes answers in the posted body', async verdict => {
    drafted();
    const blocking = verdict === 'request_changes' ? [{ path: 'src/a.ts', line: 14, body: 'This loses writes.' }] : [];
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict, blocking, decisions: REVIEW_DECISIONS }));
    if (verdict !== 'comment') enableAutoPost(verdict);
    const calls: Call[] = [];
    const event = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    for (const by of ['glass', 'cli', 'auto'] as const) {
      expect(await postReview(KEY, { by, event, token: tok, fetch: github(calls) })).toMatchObject({ posted: false, why: expect.stringContaining('Answer every decision') });
    }
    expect(await stageReview(KEY, { token: tok, fetch: github(calls) })).toMatchObject({ staged: false, why: expect.stringContaining('Answer every decision') });
    expect(calls).toEqual([]);
    answerCalls();
    expect(await postReview(KEY, { by: 'glass', event, token: tok, fetch: github(calls) })).toMatchObject({ posted: true });
    const body = posts(calls)[0]!.body!.body as string;
    expect(body).toContain('## Decisions from Chris');
    expect(body).toContain('### Who should own the rollout?\n\nProduct team — Product chooses when the feature goes live.');
    expect(body).toContain('### Should existing users get the new default?\n\nAsk each user before migrating.');
    expect(body.endsWith(MARKER)).toBe(true);
  });

  it('uses the latest answers when submitting a staged review', async () => {
    drafted();
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [], decisions: REVIEW_DECISIONS }));
    answerCalls();
    const calls: Call[] = [];
    expect(await stageReview(KEY, { token: tok, fetch: github(calls) })).toMatchObject({ staged: true });
    const r = latestRound(readReview(KEY)!)!;
    expect(answerReviewDecision(KEY, { roundId: r.id, headSha: r.headSha, draftedAt: r.draftedAt! }, 'rollout-owner', { text: 'Chris will own the rollout.' })).toBeUndefined();
    expect(await postReview(KEY, { by: 'glass', token: tok, fetch: github(calls, [{ id: 99, state: 'PENDING', body: 'My edited summary' }]) })).toMatchObject({ posted: true });
    expect(posts(calls).at(-1)?.url).toContain('/99/events');
    expect(posts(calls).at(-1)?.body?.body).toContain('Chris will own the rollout.');
    expect(posts(calls).at(-1)?.body?.body).toContain('My edited summary');
  });

  it.each(['approve', 'request_changes'] as const)('the loop never auto-posts %s with unanswered decisions', async verdict => {
    drafted(); enableAutoPost(verdict);
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict, blocking: verdict === 'request_changes' ? [{ path: 'a.ts', line: 1, body: 'Race' }] : [], decisions: REVIEW_DECISIONS }));
    const calls: Call[] = [];
    const run: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [] } } }) });
    await reviewsLoop('chris', tok, () => {}, { run, fetch: github(calls) });
    expect(posts(calls)).toEqual([]);
    answerCalls();
    await reviewsLoop('chris', tok, () => {}, { run, fetch: github(calls) });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.body?.body).toContain('Decisions from Chris');
  });
});

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
      expect(result).toMatchObject({ posted: false });
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

describe('GitHub that gives no response', () => {
  /** What Node's fetch throws when the connection resets: `fetch failed`, with the socket error as its cause. */
  const resetError = (): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

  /** The fake GitHub, except that requests matching `fails` throw a reset, `times` times each. */
  function unreachable(calls: Call[], fails: (method: string, url: string) => boolean, times = Infinity, existing: Array<{ id: number; body: string; state?: string }> = []): FetchLike {
    const fake = github(calls, existing);
    let thrown = 0;
    return async (url, init) => {
      if (fails(init.method, url) && thrown < times) {
        thrown++;
        calls.push({ method: init.method, url });
        throw resetError();
      }
      return fake(url, init);
    };
  }

  function staged(): void {
    drafted();
    const item = readReview(KEY)!;
    item.rounds[0]!.staged = { reviewId: '77', at: '2026-10-15T10:00:00Z' };
    writeReview(item);
  }

  it('names the cause of a real fetch failure, not just "fetch failed"', async () => {
    const server = net.createServer(socket => socket.destroy()).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const err = await fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`).then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ message: 'fetch failed' });
      expect(fetchFailureCause(err)).toMatch(/^(ECONNRESET|UND_ERR_SOCKET): /);
    } finally {
      server.close();
    }
  });

  it('lists each address family when both fail', () => {
    const both = Object.assign(new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT 140.82.112.5:443'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ENETUNREACH 2606:50c0::1:443'), { code: 'ENETUNREACH' }),
    ], ''), { code: 'ETIMEDOUT' });
    expect(fetchFailureCause(new TypeError('fetch failed', { cause: both })))
      .toBe('ETIMEDOUT: AggregateError (ETIMEDOUT: connect ETIMEDOUT 140.82.112.5:443; ENETUNREACH: connect ENETUNREACH 2606:50c0::1:443)');
    expect(fetchFailureCause('offline')).toBe('offline');
  });

  it('records the failed submit and its cause on the round, and never repeats the write', async () => {
    staged();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', token: tok, fetch: unreachable(calls, method => method === 'POST') });
    const failure = { step: 'post', call: 'POST /repos/acme/web/pulls/7/reviews/77/events', cause: 'ECONNRESET: read ECONNRESET' };
    expect(out).toEqual({ posted: false, why: GITHUB_UNREACHABLE, failure: { ...failure, at: expect.any(String) } });
    expect(posts(calls)).toHaveLength(1);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', reason: `post failed: ${GITHUB_UNREACHABLE}`, lastFailure: failure });
    expect(reviewFailureLogText(out as { why: string })).toBe(`${GITHUB_UNREACHABLE} (POST /repos/acme/web/pulls/7/reviews/77/events: ECONNRESET: read ECONNRESET)`);
    expect(fs.existsSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'posted.json'))).toBe(false);
  });

  it('retries a read once, then posts', async () => {
    staged();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', token: tok, fetch: unreachable(calls, (method, url) => method === 'GET' && url.endsWith('/reviews?per_page=100'), 1) });
    expect(out).toMatchObject({ posted: true });
    expect(calls.filter(call => call.url.endsWith('/reviews?per_page=100'))).toHaveLength(2);
  });

  it('a read that fails twice names that read and writes nothing', async () => {
    staged();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', token: tok, fetch: unreachable(calls, (method, url) => method === 'GET' && /\/pulls\/7$/.test(url)) });
    expect(out).toMatchObject({ posted: false, failure: { call: 'GET /repos/acme/web/pulls/7', cause: 'ECONNRESET: read ECONNRESET' } });
    expect(posts(calls)).toEqual([]);
    expect(calls.filter(call => /\/pulls\/7$/.test(call.url))).toHaveLength(2);
  });

  it('records a failed stage and its cause on the round', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await stageReview(KEY, { token: tok, fetch: unreachable(calls, method => method === 'POST') });
    expect(out).toMatchObject({ staged: false, why: GITHUB_UNREACHABLE, failure: { step: 'stage', call: 'POST /repos/acme/web/pulls/7/reviews' } });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ reason: `stage failed: ${GITHUB_UNREACHABLE}`,
      lastFailure: { step: 'stage', call: 'POST /repos/acme/web/pulls/7/reviews', cause: 'ECONNRESET: read ECONNRESET' } });
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
    enableAutoPost('request_changes');
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 1, body: 'Race' }] }));
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "alex"\nmode = "auto-draft"\nautoPostRequestChanges = "auto-post"\n');
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

  it('stages an approval with an empty body without submitting it', async () => {
    drafted();
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'review.md'), '');
    fs.writeFileSync(path.join(dir, 'comments.json'), '[]');
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    const calls: Call[] = [];
    expect(await stageReview(KEY, { token: tok, fetch: github(calls) })).toMatchObject({ staged: true });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.body).toMatchObject({ body: `\n\n${MARKER}`, comments: [] });
    expect(posts(calls)[0]?.body?.event).toBeUndefined();
    expect(latestRound(readReview(KEY)!)?.state).toBe('drafted');
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

    const repaired = latestRound(readReview(KEY)!)!;
    expect(repaired.manualPublishOnly).toBe(true);
    if (repaired.dispatch) cancelQueued(repaired.dispatch, 'chore');
    fs.rmSync(path.join(home, 'reviews'), { recursive: true });
    drafted();
    const failedItem = readReview(KEY)!;
    failedItem.rounds[0]!.autoPostRequestChanges = 'auto-post';
    writeReview(failedItem);
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 2, body: 'Race' }] }));
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
  const gone: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 0, nodes: [] }, pr0: { pullRequest: { state: 'OPEN' } } } }) });
  const config = () =>
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'work = "off"', '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'].join('\n'));

  it('post sends the staged pending review as COMMENT', async () => {
    staged();
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'cli', token: tok, fetch: github(calls) })).toMatchObject({ posted: true });
    expect(posts(calls)).toEqual([{ method: 'POST', url: 'https://api.github.com/repos/acme/web/pulls/7/reviews/77/events', body: { event: 'COMMENT', body: `Looks right.\n\n${MARKER}` } }]);
  });

  it('when the request goes, a review sent from the tool reads posted; a still-pending one stays drafted; a deleted one dismisses', async () => {
    config();
    staged();
    await reviewsLoop('chris', tok, () => {}, { run: gone, fetch: github([], [{ id: 77, body: MARKER, state: 'APPROVED' }]) });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', by: 'review tool', postedReviewId: '77' });

    fs.rmSync(path.join(home, 'reviews'), { recursive: true });
    staged();
    await reviewsLoop('chris', tok, () => {}, { run: gone, fetch: github([], [{ id: 77, body: MARKER, state: 'PENDING' }]) });
    expect(latestRound(readReview(KEY)!)!.state).toBe('drafted');

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

  it.each(['stale', 'drafted'] as const)('re-drafting a %s round keeps its pending review and unsent edits', async state => {
    staged(state);
    const calls: Call[] = [];
    expect(await redraftReviewRound(KEY, { token: tok, fetch: github(calls, [{ id: 77, body: MARKER, state: 'PENDING' }]) })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'requested' });
    expect(latestRound(readReview(KEY)!)!.staged).toBeUndefined();
  });
});

describe('Approve anyway', () => {
  it.each(['requested', 'drafting', 'drafted', 'stale', 'failed', 'dismissed', 'withdrawn', 'posted'] as const)('approves from %s without draft comments or blockers at the live head', async state => {
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state, verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 1, body: 'Race' }] });
    writeReview(item);
    const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'glass', approveAnyway: true, token: tok, fetch: github(calls, [], 200, 'bbbbbbb2') })).toMatchObject({ posted: true });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.body).toEqual({ commit_id: 'bbbbbbb2', event: 'APPROVE', body: '<!-- lobstah:review RRE_7-approve -->' });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', headSha: 'bbbbbbb2', verdict: 'approve', blocking: [], postedEvent: 'APPROVE', by: 'glass' });
  });

  it.each([true, false])('handles a staged review that still exists: %s', async exists => {
    drafted(); const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state: 'dismissed', staged: { reviewId: '77', at: 'now' } }); writeReview(item);
    const calls: Call[] = [];
    const existing = exists ? [{ id: 77, state: 'PENDING', body: MARKER }] : [];
    expect(await postReview(KEY, { by: 'glass', approveAnyway: true, token: tok, fetch: github(calls, existing) })).toMatchObject({ posted: true });
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(exists ? 1 : 0);
    expect(posts(calls)[0]?.body?.comments).toBeUndefined();
    expect(latestRound(readReview(KEY)!)?.staged).toBeUndefined();
  });

  it('refuses automation and a closed PR without posting', async () => {
    drafted(); const calls: Call[] = [];
    expect(await postReview(KEY, { by: 'auto', approveAnyway: true, token: tok, fetch: github(calls) })).toMatchObject({ posted: false });
    const item = readReview(KEY)!; item.pr.state = 'CLOSED'; writeReview(item);
    expect(await postReview(KEY, { by: 'glass', approveAnyway: true, token: tok, fetch: github(calls) })).toMatchObject({ posted: false });
    expect(posts(calls)).toEqual([]);
  });

  it('concurrent clicks submit once', async () => {
    drafted(); const calls: Call[] = []; const fetch = github(calls);
    await Promise.all([1, 2].map(() => postReview(KEY, { by: 'glass', approveAnyway: true, token: tok, fetch })));
    expect(posts(calls)).toHaveLength(1);
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
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-review"\nautoPostRequestChanges = "auto-post"\n');
    drafted();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { autoPostRequestChanges: 'auto-post', autoPostApprove: 'ask', verdict: 'request_changes', staged: { reviewId: '50', at: new Date().toISOString() } }); writeReview(item);
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 1, body: 'Race' }] }));
    const calls: Call[] = [];
    const request = github(calls);
    const fetcher: FetchLike = async (url, init) => {
      const result = await request(url, init);
      if (init.method === 'GET' && /\/pulls\/7$/.test(url)) fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-draft"\nautoPostRequestChanges = "ask"\n');
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
  enableAutoPost('request_changes');
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'verdict.json'), JSON.stringify({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 1, body: 'Race' }] }));
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


it('updates an older marked pending review without deleting unsent comments', async () => {
  drafted();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nidentity = "chris"\n');
  const calls: Call[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (init.method === 'GET' && /reviews\/77$/.test(url)) return new Response(JSON.stringify({ id: 77, state: 'PENDING', body: 'My unsent summary\n\n<!-- lobstah:review older-round -->' }));
    if (init.method === 'GET' && url.includes('/comments?')) return new Response('[]');
    if (init.method === 'GET') return new Response(JSON.stringify([
      { id: 11, state: 'PENDING', body: 'Someone else', user: { login: 'other' } },
      { id: 77, state: 'PENDING', body: 'My unsent summary\n\n<!-- lobstah:review older-round -->', user: { login: 'Chris' } },
    ]));
    return new Response(JSON.stringify({ id: 77 }));
  };
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toEqual({ staged: true, reviewId: '77' });
  expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'PUT', 'GET']);
  const update = calls.find(call => call.method === 'PUT')!.body!;
  expect(update.body).toContain('My unsent summary');
  expect(update.body).toContain('Looks right.');
  expect(update.body).toContain('Why not b()?');
  expect(calls.filter(call => call.method === 'DELETE')).toEqual([]);
  expect(latestRound(readReview(KEY)!)).toMatchObject({ staged: { reviewId: '77' } });
  expect(latestRound(readReview(KEY)!)!.reason).toBeUndefined();
});


it('preserves edits to a staged summary when submitting from glass', async () => {
  drafted();
  const item = readReview(KEY)!;
  latestRound(item)!.staged = { reviewId: '77', at: 'now' };
  writeReview(item);
  const calls: Call[] = [];
  expect(await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls, [{ id: 77, state: 'PENDING', body: 'My edited summary' }]) })).toMatchObject({ posted: true });
  expect(posts(calls)[0]!.body!.body).toBe('My edited summary');
});

it('repairs a previously withdrawn draft when GitHub confirms it is pending', async () => {
  drafted();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "notify"\n[repos.web]\npath = "/w"\norigin = "git@github.com:acme/web.git"\n');
  const item = readReview(KEY)!;
  Object.assign(latestRound(item)!, { state: 'withdrawn', staged: { reviewId: '77', at: 'now' } });
  writeReview(item);
  const run: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 0, nodes: [] }, pr0: { pullRequest: { state: 'OPEN', headRefName: 'files-upload', baseRefName: 'files-core', isCrossRepository: false } } } }) });
  await reviewsLoop('chris', tok, () => {}, { run, fetch: github([], [{ id: 77, state: 'PENDING', body: MARKER }]) });
  expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'drafted', staged: { reviewId: '77' } });
  expect(readReview(KEY)!.pr).toMatchObject({ headRefName: 'files-upload', baseRefName: 'files-core' });
});

it.each([false, true])('replaces generated pending content, preserving human comments and edits (edit during refresh: %s)', async editDuringRefresh => {
  drafted();
  let body = '';
  let comments: Array<{ id: number; path: string; body: string }> = [];
  const calls: Call[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const payload = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, ...(payload ? { body: payload } : {}) });
    if (init.method === 'GET' && /reviews\?/.test(url)) return new Response(JSON.stringify(body ? [{ id: 99, state: 'PENDING', body }] : []));
    if (init.method === 'POST' && /reviews$/.test(url)) {
      body = payload.body; comments = payload.comments.map((comment: { path: string; body: string }, index: number) => ({ ...comment, id: 101 + index }));
      return new Response('{"id":99}');
    }
    if (init.method === 'GET' && /reviews\/99$/.test(url)) return new Response(JSON.stringify({ id: 99, state: 'PENDING', body }));
    if (init.method === 'GET' && url.includes('/reviews/99/comments?')) return new Response(JSON.stringify(comments));
    if (init.method === 'GET' && /pulls\/comments\/101$/.test(url)) {
      if (editDuringRefresh) comments[0]!.body += '\nChris added more context.';
      return new Response(JSON.stringify(comments[0]));
    }
    if (init.method === 'PUT') { body = payload.body; return new Response('{"id":99}'); }
    if (init.method === 'DELETE') { comments = comments.filter(comment => !url.endsWith(`/${comment.id}`)); return new Response(null, { status: 204 }); }
    throw new Error(`${init.method} ${url}`);
  };
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: true });
  body += '\n\nChris wrote this summary.';
  comments.push({ id: 200, path: 'src/human.ts', body: 'Chris wrote this inline comment.' });
  comments.push({ ...comments[0]!, id: 201, body: comments[0]!.body + '\nChris edited this finding.' });
  expect(await redraftReviewRound(KEY, { now: Date.now() })).toBeUndefined();
  const item = readReview(KEY)!;
  Object.assign(item.pr, { headSha: 'new-head' });
  Object.assign(latestRound(item)!, { state: 'drafted', headSha: 'new-head' }); writeReview(item);
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'review.md'), 'Replacement summary.');
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'comments.json'), JSON.stringify([{ path: 'src/new.ts', line: 4, body: 'Replacement finding.' }]));
  const before = calls.length;
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: true, reviewId: '99' });
  expect(body).toContain('Chris wrote this summary.');
  expect(body).toContain('Replacement summary.'); expect(body).toContain('Replacement finding.');
  expect(body).not.toContain('Looks right.');
  expect(comments.find(comment => comment.id === 200)!.body).toBe('Chris wrote this inline comment.');
  expect(comments.find(comment => comment.id === 201)!.body).toContain('Chris edited this finding.');
  expect(comments.some(comment => comment.id === 101)).toBe(editDuringRefresh);
  expect(calls.slice(before).filter(call => call.method === 'POST')).toEqual([]);
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual(editDuringRefresh ? [] : ['https://api.github.com/repos/acme/web/pulls/comments/101']);
});

it('does not overwrite a pending review that the person submitted during staging', async () => {
  drafted();
  const methods: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
    methods.push(init.method);
    return new Response(JSON.stringify(url.includes('?')
      ? [{ id: 77, state: 'PENDING', body: MARKER }]
      : { id: 77, state: 'COMMENTED', body: 'Chris submitted this.' }));
  };
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: false, why: expect.stringContaining('already sent') });
  expect(methods).toEqual(['GET', 'GET']);
  expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', postedReviewId: '77' });
});

it.each([false, true])('recreates a pending review at the new commit without losing handwritten comments (failed replacement: %s)', async failReplacement => {
  drafted();
  let pending: { id: number; state: string; body: string; commit_id: string } | undefined;
  let comments: Array<{ id: number; path: string; line: number; body: string }> = [];
  const calls: Call[] = [];
  let creates = 0;
  const fetcher: FetchLike = async (url, init) => {
    const payload = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, ...(payload ? { body: payload } : {}) });
    if (init.method === 'GET' && /reviews\?/.test(url)) return new Response(JSON.stringify(pending ? [pending] : []));
    if (init.method === 'GET' && /reviews\/\d+$/.test(url)) return new Response(JSON.stringify(pending));
    if (init.method === 'GET' && url.includes('/comments?')) return new Response(JSON.stringify(comments));
    if (init.method === 'DELETE') { pending = undefined; comments = []; return new Response(null, { status: 204 }); }
    if (init.method === 'POST') {
      creates++;
      if (failReplacement && creates === 2) return new Response('Line not in diff', { status: 422 });
      pending = { id: creates === 1 ? 99 : 100, state: 'PENDING', body: payload.body, commit_id: payload.commit_id };
      comments = payload.comments.map((comment: { path: string; line: number; body: string }, index: number) => ({ ...comment, id: 101 + index }));
      return new Response(JSON.stringify({ id: pending.id }));
    }
    throw new Error(`${init.method} ${url}`);
  };
  expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: true });
  pending!.body += '\n\nChris wrote an unsent summary.';
  comments.push({ id: 200, path: 'src/manual.ts', line: 88, body: 'Chris wrote this comment.' });
  comments.push({ ...comments[0]!, id: 201, body: comments[0]!.body + '\nChris edited this finding.' });
  await redraftReviewRound(KEY);
  const item = readReview(KEY)!; item.pr.headSha = 'new-head';
  Object.assign(latestRound(item)!, { state: 'drafted', headSha: 'new-head' }); writeReview(item);
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'review.md'), 'Fresh summary.');
  fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'comments.json'), JSON.stringify([{ path: 'src/new.ts', line: 4, body: 'Fresh finding.' }]));
  const out = await stageReview(KEY, { token: tok, fetch: fetcher });
  if (failReplacement) {
    expect(out.staged).toBe(false); expect(pending).toBeUndefined();
    expect(latestRound(readReview(KEY)!)!.pendingReview!.preservedBody).toContain('Chris wrote this comment.');
    await redraftReviewRound(KEY);
    const retry = readReview(KEY)!; latestRound(retry)!.state = 'drafted'; writeReview(retry);
    expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toMatchObject({ staged: true });
  } else expect(out.staged).toBe(true);
  expect(pending!.commit_id).toBe('new-head'); expect(pending!.state).toBe('PENDING');
  expect(pending!.body).toContain('Chris wrote an unsent summary.');
  expect(pending!.body).toContain('src/manual.ts:88\n\nChris wrote this comment.');
  expect(pending!.body).toContain('Chris edited this finding.');
  expect(pending!.body).toContain('Fresh summary.'); expect(pending!.body).not.toContain('Looks right.');
  expect(comments.map(comment => comment.path)).toEqual(['src/new.ts']);
  expect(calls.filter(call => call.method === 'POST').every(call => !('event' in call.body!))).toBe(true);
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual(['https://api.github.com/repos/acme/web/pulls/7/reviews/99']);
});

it('dismissing a refresh removes its prior pending review and ends the Updating state', async () => {
  drafted();
  const item = readReview(KEY)!;
  Object.assign(latestRound(item)!, { state: 'requested', pendingReview: { reviewId: '77', at: 'now' }, refresh: { attempts: 1, retryAt: 'now' } }); writeReview(item);
  const calls: Call[] = [];
  expect(await dismissReviewRound(KEY, 'glass', { token: tok, fetch: github(calls, [{ id: 77, state: 'PENDING', body: 'Chris wrote this.\n\n' + MARKER }]) })).toBeUndefined();
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual(['https://api.github.com/repos/acme/web/pulls/7/reviews/77']);
  expect(latestRound(readReview(KEY)!)!.state).toBe('dismissed');
  expect(latestRound(readReview(KEY)!)!.refresh).toBeUndefined();
});


it('adopts a marker-only older draft without a configured identity or local receipt', async () => {
  drafted();
  const calls: Call[] = [];
  const result = await stageReview(KEY, { token: tok, fetch: github(calls, [{ id: 77, state: 'PENDING', body: '<!-- lobstah:review missing-round -->' }]) });
  expect(result).toEqual({ staged: true, reviewId: '77' });
  expect(posts(calls)).toEqual([]);
  expect(calls.find(call => call.method === 'PUT')!.body!.body).toContain(MARKER);
});

it('leaves a personal pending review untouched and explains how to stage', async () => {
  drafted();
  const calls: Call[] = [];
  const result = await stageReview(KEY, { token: tok, fetch: async (url, init) => {
    calls.push({ method: init.method, url });
    return new Response(JSON.stringify(url.endsWith('/user') ? { login: 'chris' } : [{ id: 77, state: 'PENDING', body: 'My draft', user: { login: 'Chris' } }]));
  } });
  expect(result).toEqual({ staged: false, why: 'You have a pending review on this PR. Send or delete it before staging a new draft.' });
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(fs.existsSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'staged.json'))).toBe(false);
});

it('dismiss removes older marked drafts without a newest-round receipt and keeps personal drafts', async () => {
  drafted();
  const calls: Call[] = [];
  expect(await dismissReviewRound(KEY, 'cli', { token: tok, fetch: github(calls, [
    { id: 77, state: 'PENDING', body: '<!-- lobstah:review older -->' },
    { id: 78, state: 'PENDING', body: 'Personal draft' },
    { id: 79, state: 'COMMENTED', body: MARKER },
  ]) })).toBeUndefined();
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual(['https://api.github.com/repos/acme/web/pulls/7/reviews/77']);
  expect(latestRound(readReview(KEY)!)!.state).toBe('dismissed');
  expect(await redraftReviewRound(KEY, { newRound: true })).toBeUndefined();
  const item = readReview(KEY)!;
  expect(item.rounds[0]!.state).toBe('dismissed');
  expect(latestRound(item)).toMatchObject({ state: 'requested', localRequest: true });
});


it.each(['stage', 'dismiss'] as const)('%s finds marked drafts beyond the first review page', async action => {
  drafted();
  const calls: Call[] = [];
  const original = github(calls, [{ id: 777, state: 'PENDING', body: '<!-- lobstah:review old -->' }]);
  const fetcher: FetchLike = async (url, init) => {
    if (init.method === 'GET' && url.endsWith('/reviews?per_page=100')) {
      calls.push({ method: init.method, url });
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, state: 'COMMENTED', body: '' }))));
    }
    return original(url, init);
  };
  if (action === 'stage') expect(await stageReview(KEY, { token: tok, fetch: fetcher })).toEqual({ staged: true, reviewId: '777' });
  else expect(await dismissReviewRound(KEY, 'cli', { token: tok, fetch: fetcher })).toBeUndefined();
  expect(calls.some(call => call.url.endsWith('&page=2'))).toBe(true);
  expect(posts(calls)).toEqual([]);
});

it('refuses a fresh round after dismiss when the PR is closed', async () => {
  drafted();
  const item = readReview(KEY)!;
  latestRound(item)!.state = 'dismissed';
  item.pr.state = 'CLOSED';
  writeReview(item);
  expect(await redraftReviewRound(KEY, { newRound: true })).toContain('closed');
  expect(readReview(KEY)!.rounds).toHaveLength(1);
});
