import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chooseReviewThread, ensureLayout, latestRound, observeReviewRequest, readReview, reviewRoundDir, writeReview } from '@lobstah/core';
import type { ReviewThread } from '@lobstah/core';
import { postReview, stageReview } from '../src/reviews-post.js';
import type { FetchLike } from '../src/reviews-post.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-resolve-threads-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "auto-draft"\n');
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const KEY = 'review:acme/web#7';
const tok = () => 'token';
const thread = (id: string, author: string): ReviewThread => ({
  id, path: 'src/a.ts', line: 4, isOutdated: false, comments: [{ author, body: 'Possible race', url: `https://github.com/acme/web/pull/7#${id}` }],
});

/** A drafted re-review at head bbb whose job judged two of Chris's threads fixed and one of Sam's. */
function drafted(): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'bbb', repoKey: 'web' },
    round: { id: 'RRE_2', requestedAt: '2026-11-18T09:00:00Z', requestedBy: 'dana' },
  });
  const dir = reviewRoundDir(KEY, 'RRE_2')!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), 'One more thing.\n');
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([{ path: 'src/b.ts', line: 2, body: 'Name this.' }]));
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [], threads: [
    { id: 'T_one', status: 'addressed', reason: 'The lock is held now.' },
    { id: 'T_two', status: 'addressed', reason: 'The retry is bounded.' },
    { id: 'T_sam', status: 'addressed', reason: 'Fixed too.' },
    { id: 'T_open', status: 'not', reason: 'Unchanged.', reply: 'Still racing in b.ts.' },
  ] }));
  const item = readReview(KEY)!;
  Object.assign(item.rounds[0]!, { state: 'drafted', dispatch: 'd1', draftedAt: '2026-11-18T12:00:00Z',
    openThreads: [thread('T_one', 'chris'), thread('T_two', 'chris'), thread('T_sam', 'sam'), thread('T_open', 'chris')] });
  writeReview(item);
}

interface Call { method: string; url: string; body?: { query?: string; variables?: { id?: string }; body?: string } }

/**
 * A fake GitHub: reviews post as 99, and each thread's live author comes
 * from `authors`. A thread in `failing` fails its resolve mutation.
 */
function github(calls: Call[], opts: { authors?: Record<string, string>; failing?: string[]; staged?: boolean } = {}): FetchLike {
  const authors = { T_one: 'chris', T_two: 'chris', T_sam: 'sam', T_open: 'chris', ...opts.authors };
  return async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, ...(body ? { body } : {}) });
    if (url.endsWith('/graphql')) {
      const id = body.variables.id as keyof typeof authors;
      if (body.query.startsWith('mutation')) {
        return opts.failing?.includes(id)
          ? new Response(JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }] }))
          : new Response(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
      }
      return new Response(JSON.stringify({ data: { node: { isResolved: false, pullRequest: { number: 7, repository: { nameWithOwner: 'acme/web' } },
        comments: { nodes: [{ author: { login: authors[id] } }] } } } }));
    }
    if (init.method === 'GET' && /\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ head: { sha: 'bbb' }, state: 'open' }));
    if (init.method === 'GET' && /\/reviews\/\d+$/.test(url)) return new Response(JSON.stringify({ id: 50, state: 'PENDING', body: '' }));
    if (init.method === 'GET') return new Response(JSON.stringify(opts.staged ? [{ id: 50, state: 'PENDING', body: 'staged' }] : []));
    return new Response(JSON.stringify({ id: 99 }));
  };
}

const resolved = (calls: Call[]) => calls.filter(call => call.body?.query?.startsWith('mutation')).map(call => call.body!.variables!.id);

describe('resolving addressed threads on publish', () => {
  it('posts the review, then resolves every ticked own thread', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls) });
    expect(out).toEqual({ posted: true, reviewId: '99', by: 'glass' });
    const post = calls.findIndex(call => call.method === 'POST' && call.url.endsWith('/reviews'));
    expect(post).toBeGreaterThan(-1);
    expect(calls.findIndex(call => call.url.endsWith('/graphql'))).toBeGreaterThan(post);
    expect(resolved(calls)).toEqual(['T_one', 'T_two']);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', threadResolution: { resolved: ['T_one', 'T_two'], failed: [] } });
    expect(latestRound(readReview(KEY)!)!.reason).toBeUndefined();
  });

  it('puts replies on own open threads in the review body', async () => {
    drafted();
    const calls: Call[] = [];
    await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls) });
    const review = calls.find(call => call.method === 'POST' && call.url.endsWith('/reviews'))!;
    expect(review.body!.body).toContain('**Earlier threads**\n\n- [src/a.ts:4](https://github.com/acme/web/pull/7#T_open): Still racing in b.ts.');
  });

  it('never resolves a thread someone else opened, even if the snapshot said otherwise', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls, { authors: { T_two: 'sam' } }) });
    expect(resolved(calls)).toEqual(['T_one']);
    expect(calls.some(call => call.body?.variables?.id === 'T_sam')).toBe(false);
    expect(out).toMatchObject({ posted: true, unresolved: [{ id: 'T_two', why: 'someone else opened the thread' }] });
  });

  it('leaves unticked threads alone', async () => {
    drafted();
    expect(chooseReviewThread(KEY, { roundId: 'RRE_2', headSha: 'bbb', draftedAt: '2026-11-18T12:00:00Z' }, 'T_two', false)).toBeUndefined();
    const calls: Call[] = [];
    await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls) });
    expect(resolved(calls)).toEqual(['T_one']);
    expect(calls.some(call => call.body?.variables?.id === 'T_two')).toBe(false);
  });

  it('a thread that fails to resolve is reported and the review stays posted', async () => {
    drafted();
    const calls: Call[] = [];
    const out = await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls, { failing: ['T_one'] }) });
    expect(out).toEqual({ posted: true, reviewId: '99', by: 'glass', unresolved: [
      { id: 'T_one', path: 'src/a.ts', line: 4, url: 'https://github.com/acme/web/pull/7#T_one', why: 'Resource not accessible by integration' },
    ] });
    const round = latestRound(readReview(KEY)!)!;
    expect(round).toMatchObject({ state: 'posted', postedReviewId: '99', threadResolution: { resolved: ['T_two'] } });
    expect(round.reason).toBe("Posted. 1 thread couldn't be resolved: src/a.ts:4 (Resource not accessible by integration). Resolve it on GitHub.");
  });

  it('a staged review sent from the glass resolves too', async () => {
    drafted();
    const calls: Call[] = [];
    expect((await stageReview(KEY, { token: tok, fetch: github(calls) })).staged).toBe(true);
    expect(resolved(calls)).toEqual([]);
    const out = await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: github(calls, { staged: true }) });
    expect(out.posted).toBe(true);
    expect(resolved(calls)).toEqual(['T_one', 'T_two']);
  });

  it('nothing is resolved when the post fails', async () => {
    drafted();
    const calls: Call[] = [];
    const failing: FetchLike = async (url, init) => init.method === 'POST' && url.endsWith('/reviews')
      ? new Response('Unprocessable', { status: 422 }) : github(calls)(url, init);
    expect((await postReview(KEY, { by: 'glass', event: 'COMMENT', token: tok, fetch: failing })).posted).toBe(false);
    expect(calls.some(call => call.url.endsWith('/graphql'))).toBe(false);
  });
});
