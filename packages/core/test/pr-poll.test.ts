import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  cachedPrStackLink,
  cachedPrView,
  ensureLayout,
  githubBlockedUntil,
  githubPollIntervalSecs,
  listNotices,
  parsePrRef,
  prBatchQuery,
  preparePrWatchBatch,
  readWatch,
  recordGitHubRateLimit,
  recordGitHubResponse,
  recordWatchFailure,
  recordWatchSuccess,
  retireTerminalPrWatches,
  splitGitHubResponse,
  upsertPr,
  prEvidence,
  watchesDir,
} from '../src/index.js';
import type { GhPrView, PrRef, PrBatchRun } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const T = Date.parse('2026-10-09T08:00:00Z');
const ref = (n: number, repo = 'web') => parsePrRef(`pr:acme/${repo}#${n}`)!;
const view = (n: number): GhPrView => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: `sha${n}`,
  baseRefName: 'main',
  baseRefOid: 'base',
  headRefName: `feature-${n}`,
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [],
  reviews: [],
});
const snapshot = (n: number) => ({
  ...view(n),
  number: n,
  url: ref(n).url,
  reviews: { nodes: [], pageInfo: { endCursor: 'review-0' } },
  comments: { nodes: [], pageInfo: { endCursor: 'comment-0' } },
  reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'ci',
                  status: 'COMPLETED',
                  conclusion: 'SUCCESS',
                  checkSuite: { app: { slug: 'actions' } },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ],
  },
});
const response = (repository: Record<string, unknown>, remaining = 4000) => ({
  status: 0,
  stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${(T + 3600_000) / 1000}\r\n\r\n${JSON.stringify({ data: { repository, rateLimit: { cost: 1 } } })}`,
});
const register = (n: number, repo = 'web') => addWatch(ref(n, repo).key, `lobstah watch check-pr '${ref(n, repo).key}' --cursor {cursor}`);
const saveWatch = (w: ReturnType<typeof register>) =>
  fs.writeFileSync(path.join(watchesDir(), `${w.key.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`), JSON.stringify(w));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-poll-'));
  process.env.LOBSTAH_HOME = home;
  process.env.LOBSTAH_PR_BATCH = '1';
  ensureLayout();
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_PR_BATCH;
  removeTempDir(home);
});

describe('repository PR batch', () => {
  it('40 watches make 80 batch calls/hour, not 6400 legacy view/thread calls; unchanged snapshots need no details', () => {
    const repo: Record<string, unknown> = {};
    for (let n = 1; n <= 40; n++) {
      register(n);
      repo[`pr${n}`] = snapshot(n);
    }
    const run = vi.fn(() => response(repo)),
      detail = vi.fn(() => view(1));
    for (let tick = 0; tick < 80; tick++) {
      vi.setSystemTime(T + tick * 45_000);
      preparePrWatchBatch(45, Date.now(), { run, detail });
      // A concurrent feeder in the same cadence window uses this cycle too.
      preparePrWatchBatch(45, Date.now(), { run, detail });
    }
    expect(run).toHaveBeenCalledTimes(80);
    expect(detail).not.toHaveBeenCalled();
    expect(cachedPrView(ref(40))).toMatchObject({
      headRefOid: 'sha40',
      unresolvedThreads: 1,
      statusCheckRollup: [{ name: 'ci', app: { slug: 'actions' } }],
    });
  });

  it('one query per repository; custom checks are not replaced', () => {
    register(1);
    register(2);
    register(3, 'api');
    addWatch(ref(4).key, 'echo custom');
    const run = vi.fn<PrBatchRun>((query, r) => response(Object.fromEntries([1, 2, 3].map((n) => [`pr${n}`, snapshot(n)]))));
    preparePrWatchBatch(45, T, { run });
    expect(run).toHaveBeenCalledTimes(2);
    const q = run.mock.calls.find(([, r]) => r.repo === 'web')![0];
    expect(q).toContain('pr1:pullRequest(number:1)');
    expect(q).toContain('pr2:pullRequest(number:2)');
    expect(q).not.toContain('pr4:');
    expect(q).toContain('comments(last:1)');
    expect(q).toContain('reviews(last:100)');
  });

  it('reads details only for changed/incomplete PRs, reusing detail on the next unchanged cycle', () => {
    register(1);
    register(2);
    const raw = snapshot(1);
    raw.commits.nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    const run = () => response({ pr1: raw, pr2: snapshot(2) });
    const detail = vi.fn(() => ({ ...view(1), unresolvedThreads: 4 }));
    preparePrWatchBatch(45, T, { run, detail });
    preparePrWatchBatch(45, T + 45_000, { run, detail });
    expect(detail).toHaveBeenCalledTimes(1);
    expect(cachedPrView(ref(1))?.unresolvedThreads).toBe(4);
    raw.comments.pageInfo.endCursor = 'new-comment';
    preparePrWatchBatch(45, T + 90_000, { run, detail });
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('caches positive and negative branch links so stack discovery does not poll per watch', () => {
    register(1);
    upsertPr(prEvidence(ref(1), view(1), new Date(T).toISOString()));
    const { query, links } = prBatchQuery([ref(1)]);
    expect(query).toContain('baseRefName:"feature-1"');
    const repository: Record<string, unknown> = { pr1: snapshot(1) };
    for (const link of links) repository[link.alias] = { nodes: link.key.endsWith(':base:feature-1') ? [snapshot(2)] : [] };
    preparePrWatchBatch(45, T, { run: () => response(repository) });
    expect(cachedPrStackLink(ref(1), 'feature-1', 'base')?.[0]?.number).toBe(2);
    expect(cachedPrStackLink(ref(1), 'main', 'head')).toEqual([]);
    expect(cachedPrStackLink(ref(1), 'unknown', 'head')).toBeUndefined();
  });

  it("does not bypass a watch backoff with detail calls from another watch's batch", () => {
    const w = register(1);
    register(2);
    const raw = snapshot(1);
    raw.reviews.pageInfo = { ...raw.reviews.pageInfo, hasPreviousPage: true };
    const run = () => response({ pr1: raw, pr2: snapshot(2) });
    const detail = vi.fn(() => view(1));
    preparePrWatchBatch(45, T, { run, detail });
    Object.assign(w, { lastCheckedAt: new Date(T).toISOString(), failures: 3, errorKind: 'auth' });
    saveWatch(w);
    raw.comments.pageInfo.endCursor = 'changed';
    preparePrWatchBatch(45, T + 45_000, { run, detail });
    expect(detail).toHaveBeenCalledTimes(1);
    preparePrWatchBatch(45, T + 360_000, { run, detail });
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('an incomplete changed snapshot does not masquerade as an old success or bypass detail backoff', () => {
    const w = register(1);
    register(2);
    const raw = snapshot(1);
    raw.reviews.pageInfo = { ...raw.reviews.pageInfo, hasPreviousPage: true };
    const run = () => response({ pr1: raw, pr2: snapshot(2) });
    const detail = vi.fn(() => ({ ...view(1), headRefOid: raw.headRefOid }));
    preparePrWatchBatch(45, T, { run, detail });
    Object.assign(w, { lastCheckedAt: new Date(T).toISOString(), failures: 3, errorKind: 'auth' });
    saveWatch(w);
    raw.headRefOid = 'changed-head';
    preparePrWatchBatch(45, T + 45_000, { run, detail });
    expect(() => cachedPrView(ref(1))).toThrow('details deferred');
    preparePrWatchBatch(45, T + 90_000, { run, detail });
    expect(() => cachedPrView(ref(1))).toThrow('details deferred');
    expect(detail).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T + 360_000);
    preparePrWatchBatch(45, Date.now(), { run, detail });
    expect(cachedPrView(ref(1))).toMatchObject({ headRefOid: 'changed-head', fetchedAt: new Date(T + 360_000).toISOString() });
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('cache reads preserve fetch time; an unchanged new GitHub read advances it', () => {
    register(1);
    const run = vi.fn(() => response({ pr1: snapshot(1) }));
    preparePrWatchBatch(45, T, { run });
    vi.setSystemTime(T + 30_000);
    preparePrWatchBatch(45, Date.now(), { run });
    expect(cachedPrView(ref(1))?.fetchedAt).toBe(new Date(T).toISOString());
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T + 45_000);
    preparePrWatchBatch(45, Date.now(), { run });
    expect(cachedPrView(ref(1))?.fetchedAt).toBe(new Date(T + 45_000).toISOString());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('dates the snapshot when the repository response arrives, not at the start of a long polling pass', () => {
    register(1);
    preparePrWatchBatch(45, T, { run: () => {
      vi.setSystemTime(T + 2_000);
      return response({ pr1: snapshot(1) });
    } });
    expect(cachedPrView(ref(1))?.fetchedAt).toBe(new Date(T + 2_000).toISOString());
  });

  it('retires existing merged/closed watches at startup, without any API or duplicate notice', () => {
    for (const [n, state] of [
      [1, 'MERGED'],
      [2, 'CLOSED'],
    ] as const) {
      register(n);
      upsertPr(prEvidence(ref(n), { ...view(n), state }, new Date(T).toISOString()));
    }
    expect(retireTerminalPrWatches()).toHaveLength(2);
    expect(readWatch(ref(1).key)).toBeUndefined();
    expect(readWatch(ref(2).key)).toBeUndefined();
    const run = vi.fn(() => response({}));
    preparePrWatchBatch(45, T, { run });
    expect(run).not.toHaveBeenCalled();
    expect(listNotices()).toEqual([]);
  });
});

describe('shared GitHub budget', () => {
  it('reads response headers without another API request and stretches a low-budget cycle to leave half for workers', () => {
    const parsed = splitGitHubResponse(response({}, 100).stdout);
    expect(JSON.parse(parsed.body).data.repository).toEqual({});
    recordGitHubResponse(parsed.headers, { now: T, cost: 5 });
    expect(githubPollIntervalSecs(45, T)).toBe(360);
    expect(githubPollIntervalSecs(45, T, 2)).toBe(720);
    expect(githubPollIntervalSecs(45, T + 3600_000)).toBe(45);
  });

  it('one shared rate-limit notice and recovery, no per-watch streaks; waits until reset', () => {
    for (let n = 1; n <= 40; n++) register(n);
    const run = vi.fn(() => ({ ...response({}, 0), status: 1, stderr: 'API rate limit already exceeded' }));
    preparePrWatchBatch(45, T, { run });
    expect(githubBlockedUntil(T)).toBe(T + 3600_000);
    for (let n = 1; n <= 40; n++) {
      const w = readWatch(ref(n).key)!;
      recordWatchFailure(w, 'API rate limit exceeded', 1, new Date(T + 1000));
      expect(w.failures).toBeUndefined();
    }
    preparePrWatchBatch(45, T + 45_000, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(listNotices(100).map((n) => n.kind)).toEqual(['rate-limited']);
    vi.setSystemTime(T + 3600_000);
    preparePrWatchBatch(45, Date.now(), {
      run: () => response(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pr${i + 1}`, snapshot(i + 1)]))),
    });
    expect(listNotices(100).map((n) => n.kind)).toEqual(['rate-limited', 'rate-limit-recovered']);
  });

  it('honors Retry-After and does not extend the window for each watch error', () => {
    recordGitHubRateLimit(T, T + 120_000);
    recordGitHubRateLimit(T + 90_000);
    expect(githubBlockedUntil(T + 90_000)).toBe(T + 120_000);
  });

  it('legacy per-watch rate-limit failures recover silently; other failure streaks remain intact', () => {
    const w = register(1);
    Object.assign(w, { failures: 3, errorKind: 'rate-limit', failingNoticed: true });
    recordWatchSuccess(w);
    expect(listNotices()).toEqual([]);
    recordWatchFailure(w, 'bad credentials', 1, new Date(T));
    recordWatchFailure(w, 'API rate limit exceeded', 1, new Date(T));
    expect(w.failures).toBe(1);
    expect(w.errorKind).toBe('auth');
  });

  it('clears persisted legacy rate-limit backoff before polling, without a recovery storm', () => {
    const w = register(1);
    Object.assign(w, { lastCheckedAt: new Date(T - 45_000).toISOString(), failures: 3, errorKind: 'rate-limit', failingNoticed: true });
    saveWatch(w);
    const run = vi.fn(() => response({ pr1: snapshot(1) }));
    preparePrWatchBatch(45, T, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(readWatch(w.key)?.failures).toBeUndefined();
    expect(readWatch(w.key)?.errorKind).toBeUndefined();
    expect(listNotices()).toEqual([]);
  });
});
