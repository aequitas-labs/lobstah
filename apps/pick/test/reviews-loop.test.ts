import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, claimNext, dismissReview, dispatchWasCancelled, ensureLayout, latestRound, listReviews, pendingIds, readReview, recordGitHubRateLimit, reviewAsker, writeReview } from '@lobstah/core';
import { runPickup } from '../src/run.js';
import { REVIEW_SEARCH, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-loop-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(`diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-old\n+${url.split('...').at(-1)}\n`)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOBSTAH_TEST_REVIEW_TOKEN;
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const ME = 'chris';
// work = "off": these tests are about the search; drafting has its own (reviews-draft.test.ts).
const CONFIG = ['[reviews]', 'enabled = true', 'work = "off"', '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'];

interface Pr {
  number: number;
  repo?: string;
  author?: string;
  labels?: string[];
  head?: string;
  requester?: string;
  automatic?: boolean;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  reviews?: Array<{ id: number; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; head: string; at: string }>;
  requests?: Array<{ id: string; at: string; to: string; team?: boolean; actor?: { login: string; __typename?: string; name?: string; avatarUrl?: string } }>;
}

function node(pr: Pr) {
  return {
    number: pr.number,
    url: `https://github.com/${pr.repo ?? 'acme/web'}/pull/${pr.number}`,
    title: `pr ${pr.number}`,
    isDraft: false,
    headRefOid: pr.head ?? 'aaaaaaa1',
    baseRefOid: 'ccccccc3',
    author: { login: pr.author ?? 'dana', name: 'Dana Developer', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' },
    repository: { nameWithOwner: pr.repo ?? 'acme/web' },
    labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
    reviews: { nodes: (pr.reviews ?? []).map((review) => ({ databaseId: review.id, state: review.state, submittedAt: review.at, commit: { oid: review.head } })) },
    timelineItems: {
      nodes: (pr.requests ?? [{ id: `RRE_${pr.number}`, at: '2026-10-15T09:00:00Z', to: ME }]).map((r) => ({
        id: r.id,
        createdAt: r.at,
        actor: r.actor ?? { login: pr.requester ?? 'dana', __typename: pr.automatic ? 'Bot' : 'User', name: pr.automatic ? undefined : 'Dana Developer', avatarUrl: 'https://avatars.githubusercontent.com/u/8?v=4' },
        requestedReviewer: r.team ? { __typename: 'Team' } : { __typename: 'User', login: r.to },
      })),
    },
  };
}

/** A fake `gh api graphql --include` that answers with these PRs and records each call. */
function gh(prs: Pr[], calls: Array<{ query: string; q: string }>, issueCount?: number, missing: Pr[] = []): GhGraphql {
  return (body) => {
    calls.push({ query: body.query, q: String(body.variables.q) });
    const headers = 'HTTP/2.0 200 OK\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 4990\nX-Ratelimit-Reset: 9999999999\n\n';
    const data = body.query === REVIEW_SEARCH
      ? { rateLimit: { cost: 1 }, search: { issueCount: issueCount ?? prs.length, nodes: prs.map(node) } }
      : Object.fromEntries(Object.keys(body.variables).filter((key) => key.startsWith('number')).map((key) => {
          const pr = missing.find((candidate) => candidate.number === body.variables[key]);
          return [`pr${key.slice('number'.length)}`, { pullRequest: { state: pr?.state ?? 'OPEN', reviews: node(pr ?? { number: Number(body.variables[key]) }).reviews } }];
        }));
    return { status: 0, stdout: headers + JSON.stringify({ data }) };
  };
}

const config = (...extra: string[]) => fs.writeFileSync(path.join(home, 'config.toml'), [...CONFIG, ...extra].join('\n'));
const tok = () => 'token';

describe('the reviews loop', () => {
  it.each([
    { requester: 'codeclaw', automatic: true },
    { requester: 'maya', automatic: false },
  ])('keeps the existing draft when $requester re-requests at the same SHA', async (requester) => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const item = readReview('review:acme/web#1')!;
    Object.assign(latestRound(item)!, { state: 'drafted', draftedAt: '2026-10-15T10:00:00Z' });
    writeReview(item);
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'mode = "auto-draft"', 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
    const requests = [{ id: 'again', at: '2026-10-15T11:00:00Z', to: ME }];
    for (let i = 0; i < 2; i++) await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, ...requester, requests }], []) });
    const after = readReview(item.key)!;
    expect(after.rounds).toHaveLength(1);
    expect(latestRound(after)).toMatchObject({ id: 'RRE_1', requestEventId: 'again', state: 'drafted', draftedAt: '2026-10-15T10:00:00Z' });
    expect(pendingIds('chore')).toEqual([]);
  });

  it('starts one new draft when a push is followed by a re-request', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const item = readReview('review:acme/web#1')!;
    latestRound(item)!.state = 'drafted';
    writeReview(item);
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'mode = "auto-draft"', 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
    const pr = { number: 1, head: 'bbbbbbb2', requests: [{ id: 'after-push', at: '2026-10-15T11:00:00Z', to: ME }] };
    for (let i = 0; i < 2; i++) await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    expect(readReview(item.key)!.rounds.map((round) => round.state)).toEqual(['withdrawn', 'drafting']);
    expect(latestRound(readReview(item.key)!)).toMatchObject({ id: 'after-push', headSha: 'bbbbbbb2' });
    expect(pendingIds('chore')).toHaveLength(1);
  });

  it.each(['on-demand', 'auto-draft', 'auto-review'] as const)(
    '%s opens a new round after Skip and a push while the same request stands', async (mode) => {
      config();
      const pr: Pr = { number: 1 };
      await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
      dismissReview('review:acme/web#1', 'glass');
      fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', `mode = "${mode}"`, 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
      await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
      expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('dismissed');
      pr.head = 'bbbbbbb2';
      for (let i = 0; i < 2; i++) await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
      const after = readReview('review:acme/web#1')!;
      expect(after.rounds).toHaveLength(2);
      expect(after.rounds[0]!.state).toBe('dismissed');
      expect(latestRound(after)).toMatchObject({ requestEventId: 'RRE_1', headSha: 'bbbbbbb2', state: mode === 'on-demand' ? 'requested' : 'drafting' });
      expect(pendingIds('chore')).toHaveLength(mode === 'on-demand' ? 0 : 1);
    },
  );

  it('a new head waits when the daily automatic limit is reached', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'mode = "auto-draft"', 'maxPerDay = 1', 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
    const pr: Pr = { number: 1 };
    await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    dismissReview('review:acme/web#1', 'glass');
    pr.head = 'bbbbbbb2';
    await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    expect(latestRound(readReview('review:acme/web#1')!)).toMatchObject({ state: 'requested', headSha: 'bbbbbbb2', reason: expect.stringContaining('daily cap') });
  });

  it.each(['dismissed', 'posted', 'stale'] as const)('a push after a %s round opens nothing when the request is removed', async (state) => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const item = readReview('review:acme/web#1')!;
    latestRound(item)!.state = state;
    writeReview(item);
    await reviewsLoop(ME, tok, () => {}, { run: gh([], [], undefined, [{ number: 1, head: 'bbbbbbb2' }]) });
    expect(readReview(item.key)!.rounds).toHaveLength(1);
    expect(pendingIds('chore')).toEqual([]);
  });

  it.each(['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'] as const)('a submitted %s review completes its head and drafts again only after a push', async (state) => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'mode = "auto-draft"', 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
    const pr: Pr = { number: 1, reviews: [{ id: 77, state, head: 'aaaaaaa1', at: '2026-10-15T10:00:00Z' }] };
    await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    expect(latestRound(readReview('review:acme/web#1')!)).toMatchObject({ state: 'posted', postedReviewId: '77', by: 'review tool', verdict: state === 'COMMENTED' ? 'comment' : state === 'APPROVED' ? 'approve' : 'request_changes' });
    pr.requests = [{ id: 'again', at: '2026-10-15T11:00:00Z', to: ME }];
    await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    expect(readReview('review:acme/web#1')!.rounds).toHaveLength(1);
    expect(pendingIds('chore')).toEqual([]);
    pr.head = 'bbbbbbb2';
    // The same request event still stands after this push.
    await reviewsLoop(ME, tok, () => {}, { run: gh([pr], []) });
    expect(latestRound(readReview('review:acme/web#1')!)).toMatchObject({ state: 'drafting', headSha: 'bbbbbbb2' });
    expect(pendingIds('chore')).toHaveLength(1);
  });

  it.each([
    ['MERGED', 'merged'], ['CLOSED', 'closed'], ['OPEN', 'withdrawn'],
  ] as const)('a vanished request on a %s PR becomes %s', async (state, expected) => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([], [], undefined, [{ number: 1, state }]) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe(expected);
  });

  it('records an unstaged COMMENTED review when the request disappears', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([], [], undefined, [{ number: 1,
      reviews: [{ id: 77, state: 'COMMENTED', head: 'aaaaaaa1', at: '2026-10-15T10:00:00Z' }] }]) });
    expect(latestRound(readReview('review:acme/web#1')!)).toMatchObject({ state: 'posted', postedReviewId: '77', verdict: 'comment' });
  });

  it('cancels a running draft after Chris submits a review of its head', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'work = "headless"', 'requestedAfter = "1970-01-01T00:00:00Z"', ...CONFIG.slice(3)].join('\n'));
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const dispatch = latestRound(readReview('review:acme/web#1')!)!.dispatch!;
    claimNext('chore');
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1,
      reviews: [{ id: 77, state: 'COMMENTED', head: 'aaaaaaa1', at: '2026-10-15T10:00:00Z' }] }], []) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('posted');
    expect(dispatchWasCancelled(dispatch, 'chore')).toBe(true);
  });

  it('repairs an already withdrawn row when the PR later merges', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([], [], undefined, [{ number: 1, state: 'MERGED' }]) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('merged');
  });

  it('leaves a missing request alone when its PR state cannot be confirmed', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const search = gh([], []);
    const run: GhGraphql = (body, token) => body.query === REVIEW_SEARCH ? search(body, token) : { status: 1, stdout: '', stderr: 'HTTP 502' };
    await reviewsLoop(ME, tok, () => {}, { run });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('requested');
  });

  it.each([
    { requester: 'github-actions', automatic: false },
    { requester: 'github-actions[bot]', automatic: false },
    { requester: 'approval-gate[bot]', automatic: false },
    { requester: 'approval-gate', automatic: true },
  ])('attributes a bot-only request to the PR author: $requester', async (requester) => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, ...requester }], []) });
    const item = readReview('review:acme/web#1')!;
    expect(reviewAsker(item, latestRound(item)!)).toEqual({ login: 'dana', name: 'Dana Developer', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' });
    expect(latestRound(item)).toMatchObject({ id: 'RRE_1', requestedBy: requester.requester, requestedAutomatically: true });
  });

  it('keeps the latest human requester for this reviewer when a bot re-requests, across later polls', async () => {
    config();
    const requests = [
      { id: 'old-human', at: '2026-10-15T07:00:00Z', to: ME, actor: { login: 'alex', __typename: 'User' } },
      { id: 'human', at: '2026-10-15T08:00:00Z', to: ME, actor: { login: 'maya', __typename: 'User', name: 'Maya Maintainer', avatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4' } },
      { id: 'unrelated-human', at: '2026-10-15T08:30:00Z', to: 'someone-else', actor: { login: 'other', __typename: 'User' } },
      { id: 'bot', at: '2026-10-15T09:00:00Z', to: ME, actor: { login: 'github-actions', __typename: 'Bot' } },
    ];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, requests }], []) });
    let item = readReview('review:acme/web#1')!;
    expect(latestRound(item)).toMatchObject({ id: 'bot', requestedAutomatically: true, humanRequester: { login: 'maya' } });
    expect(reviewAsker(item, latestRound(item)!)).toEqual({ login: 'maya', name: 'Maya Maintainer', avatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4' });
    // Older human events can fall outside the timeline window on subsequent polls.
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, requests: [requests[3]!] }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, requests: [{ ...requests[3]!, id: 'bot-again', at: '2026-10-15T10:00:00Z' }] }], []) });
    item = readReview('review:acme/web#1')!;
    expect(item.rounds).toHaveLength(1);
    expect(latestRound(item)).toMatchObject({ id: 'bot', requestEventId: 'bot-again' });
    expect(reviewAsker(item, latestRound(item)!)).toMatchObject({ login: 'maya' });
  });
  it('new requests remain silent across polls, with no notification callbacks', async () => {
    config(); const notify = vi.fn();
    for (let i = 0; i < 2; i++) await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []), notify });
    expect(listReviews()).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    expect(latestRound(readReview('review:acme/web#1')!)?.notification).toBeUndefined();
  });

  it('fetches and caches requester and author names/avatars in the same gh search', async () => {
    config();
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1, requester: 'github-actions', automatic: true }], calls) });
    expect(calls).toHaveLength(1);
    expect(readReview('review:acme/web#1')).toMatchObject({
      pr: { authorName: 'Dana Developer', authorAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' },
      rounds: [{ requestedBy: 'github-actions', requestedAutomatically: true, requestedByAvatarUrl: 'https://avatars.githubusercontent.com/u/8?v=4' }],
    });
  });

  it('a self-contained reviews block needs no pickup table and notify mode dispatches nothing', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\nrepos = "any"\n');
    process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
    const checked = path.join(home, 'unexpected-watch-check');
    const script = path.join(home, 'watch.cjs');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(checked)}, 'ran'); console.log('{"cursor":"1","events":[]}');`);
    addWatch('fixture:unrelated', `node "${script}"`);
    await runPickup('once', { reviewRun: gh([{ number: 2 }], []) });
    expect(fs.existsSync(checked)).toBe(false);
    expect(listReviews()).toHaveLength(1);
    expect(pendingIds('work')).toEqual([]);
    expect(pendingIds('chore')).toEqual([]);
  });
  it('a reviews-only pick cycle files requests without polling authored PR feedback or dispatching jobs', async () => {
    config();
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[pickup.github]\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\n');
    process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
    // If PR-feedback pickup runs, this identity-owned PR would yield fresh feedback.
    const fetcher = vi.fn(async (url: string) => url.includes('/compare/')
      ? new Response('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n')
      : new Response(JSON.stringify([{
      number: 99, html_url: 'https://github.com/acme/web/pull/99', user: { login: ME },
      head: { ref: 'lobstah/11111111-1111-4111-8111-111111111111', sha: 'aaaaaaa1' },
      body: 'Please fix the new review comments',
    }])));
    vi.stubGlobal('fetch', fetcher);
    await runPickup('once', { reviewRun: gh([{ number: 1, author: ME }], []) });
    expect(listReviews()).toHaveLength(1);
    expect(latestRound(listReviews()[0]!)?.state).toBe('requested');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toContain('/compare/');
    expect(pendingIds('work')).toEqual([]);
    expect(pendingIds('chore')).toEqual([]);
  });
  it('with no [reviews] table makes no call and files nothing', async () => {
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], calls) });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'reviews'))).toBe(false);
  });

  it('searches once per cycle for direct requests, on the shared budget', async () => {
    config();
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }, { number: 2 }], calls) });
    expect(calls).toEqual([{ query: REVIEW_SEARCH, q: 'is:pr is:open user-review-requested:chris archived:false' }]);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'github-budget.json'), 'utf8')).resources.graphql).toMatchObject({ remaining: 4990 });
    expect(listReviews().map((r) => r.key).sort()).toEqual(['review:acme/web#1', 'review:acme/web#2']);
    expect(readReview('review:acme/web#1')).toMatchObject({ pr: { repoKey: 'web', author: 'dana' }, rounds: [{ id: 'RRE_1', requestedBy: 'dana', state: 'requested' }] });
  });

  it('makes no call while the GitHub budget is blocked', async () => {
    config();
    recordGitHubRateLimit(Date.now(), Date.now() + 60_000);
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], calls) });
    expect(calls).toEqual([]);
  });

  it('a PR whose only request names a team files nothing; the newest direct request is the round', async () => {
    config();
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, {
      run: gh(
        [
          { number: 3, requests: [{ id: 'RRE_t', at: '2026-10-15T09:00:00Z', to: '', team: true }] },
          {
            number: 4,
            requests: [
              { id: 'RRE_a', at: '2026-10-15T08:00:00Z', to: ME },
              { id: 'RRE_b', at: '2026-10-15T09:00:00Z', to: ME },
              { id: 'RRE_c', at: '2026-10-15T10:00:00Z', to: 'someone-else' },
            ],
          },
        ],
        calls,
      ),
    });
    expect(listReviews().map((r) => r.key)).toEqual(['review:acme/web#4']);
    expect(latestRound(readReview('review:acme/web#4')!)!.id).toBe('RRE_b');
  });

  it('keeps to configured repos unless repos = "any"; skip rules file with a reason', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'skipLabels = ["deps"]', ...CONFIG.slice(3)].join('\n'));
    const prs = [{ number: 5, repo: 'other/lib' }, { number: 6, labels: ['deps'] }];
    await reviewsLoop(ME, tok, () => {}, { run: gh(prs, []) });
    expect(listReviews().map((r) => r.key)).toEqual(['review:acme/web#6']);
    expect(latestRound(readReview('review:acme/web#6')!)!.reason).toBe('skipped: label deps is in skipLabels');

    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'repos = "any"', ...CONFIG.slice(3)].join('\n'));
    await reviewsLoop(ME, tok, () => {}, { run: gh(prs, []) });
    expect(readReview('review:other/lib#5')!.pr.repoKey).toBeUndefined();
  });

  it('withdraws a request the search stopped returning, unless the search was truncated', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }, { number: 2 }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 2 }], [], 60) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('requested');
    const logs: string[] = [];
    await reviewsLoop(ME, tok, (m) => logs.push(m), { run: gh([{ number: 2 }], []) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('withdrawn');
    expect(logs).toEqual(['review:acme/web#1: review request gone; round withdrawn']);
  });

  it('a failed search changes nothing', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const logs: string[] = [];
    await reviewsLoop(ME, tok, (m) => logs.push(m), { run: () => ({ status: 1, stdout: '', stderr: 'HTTP 502: bad gateway' }) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('requested');
    expect(logs[0]).toContain('reviews: search failed: HTTP 502');
  });
});

it('files historical requests without jobs on enable and starts only requests after the cutoff', async () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "auto-review"\n[repos.web]\npath = "/w"\norigin = "https://github.com/acme/web.git"\n');
  const { loadConfig, reviewAutomationCutoff } = await import('@lobstah/core');
  reviewAutomationCutoff(loadConfig().reviews, undefined, now - 3600000);
  const prs = [
    { number: 1, requests: [{ id: 'old', at: '2026-10-15T09:00:00Z', to: ME }] },
    { number: 2, requests: [{ id: 'new', at: '2026-11-11T11:30:00Z', to: ME }] },
  ];
  for (let i = 0; i < 2; i++) await reviewsLoop(ME, tok, () => {}, { now: now + i, run: gh(prs, []) });
  expect(listReviews()).toHaveLength(2);
  expect(latestRound(readReview('review:acme/web#1')!)).toMatchObject({ state: 'requested', reason: expect.stringContaining('requested before') });
  expect(latestRound(readReview('review:acme/web#1')!)?.dispatch).toBeUndefined();
  expect(latestRound(readReview('review:acme/web#2')!)?.state).toBe('drafting');
  expect(pendingIds('chore')).toHaveLength(1);
});
