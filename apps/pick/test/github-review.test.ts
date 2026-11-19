import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, complete, ensureLayout, laneDirs, pendingIds, readDescriptor } from '@lobstah/core';
import { GithubSource, guardFeedback } from '../src/sources/github.js';
import type { GithubConfig } from '../src/sources/github.js';
import { lobstahWrote, markedNote, marker } from '../src/types.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { dispatchLoop } from '../src/loops/dispatch.js';
import { PickupState } from '../src/state.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ghrev-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const IDENTITY = 'octoclaw';
const UUID = '11111111-1111-1111-1111-111111111111';

function source(over: Partial<GithubConfig> = {}): GithubSource {
  return new GithubSource({
    repo: 'o/r',
    key: 'demo',
    identity: IDENTITY,
    token: () => 't',
    startLabel: 'lobstah',
    claimedLabel: 'lobstah-claimed',
    ...over,
  });
}

interface PrFixture {
  number: number;
  branch: string;
  author?: string;
  reviews?: Array<{ id: number; login: string; state: string; sha?: string; body?: string; at: string }>;
  reviewComments?: Array<{ id: number; login: string; body: string; at: string; reviewId?: number; replyTo?: number }>;
  issueComments?: Array<{ id: number; login: string; body: string; at: string }>;
  threads?: Array<{ root: number; path: string; line: number | null; originalLine?: number; resolved?: boolean }>;
}

/** Stub the GitHub API with just the routes poll() walks. */
function stubApi(prs: PrFixture[]): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    let body: unknown = [];
    if (p === '/repos/o/r/issues') body = [];
    else if (p === '/repos/o/r/pulls') {
      body = prs.map((pr) => ({
        number: pr.number,
        title: `pr ${pr.number}`,
        state: 'open',
        html_url: `https://github.com/o/r/pull/${pr.number}`,
        user: { login: pr.author ?? IDENTITY },
        head: { ref: pr.branch, sha: 'headsha' },
        labels: [],
        assignees: [],
        draft: false,
      }));
    } else if (p === '/graphql') {
      const request = JSON.parse(String(init?.body)) as { variables: { number: number; cursor: string | null } };
      const pr = prs.find((value) => value.number === request.variables.number)!;
      const offset = Number(request.variables.cursor ?? 0);
      const threads = pr.threads ?? [];
      body = { data: { repository: { pullRequest: { reviewThreads: {
        nodes: threads.slice(offset, offset + 100).map((thread) => ({
          path: thread.path, line: thread.line, originalLine: thread.originalLine ?? thread.line,
          isResolved: thread.resolved ?? false,
          comments: { nodes: [{ id: `comment_${thread.root}`, url: `https://github.com/o/r/pull/${pr.number}#discussion_r${thread.root}` }] },
        })),
        pageInfo: { hasNextPage: offset + 100 < threads.length, endCursor: String(offset + 100) },
      } } } } };
    } else {
      const m = /^\/repos\/o\/r\/(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(p);
      const pr = m ? prs.find((x) => x.number === Number(m[2])) : undefined;
      if (m && pr) {
        const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * 100;
        if (m[1] === 'pulls' && m[3] === 'reviews') {
          body = (pr.reviews ?? []).slice(offset, offset + 100).map((r) => ({
            id: r.id,
            user: { login: r.login },
            state: r.state,
            commit_id: r.sha ?? 'headsha',
            submitted_at: r.at,
            body: r.body ?? null,
          }));
        } else {
          const list = m[1] === 'pulls' ? pr.reviewComments : pr.issueComments;
          body = (list ?? []).slice(offset, offset + 100).map((c) => ({
            id: c.id, node_id: `comment_${c.id}`, user: { login: c.login }, body: c.body, created_at: c.at,
            ...('reviewId' in c ? { pull_request_review_id: c.reviewId } : {}),
            ...('replyTo' in c ? { in_reply_to_id: c.replyTo } : {}),
          }));
        }
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('post-PR feedback pickup', () => {
  it('disabled issue and PR-feedback pickup makes no API call', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await source({ issues: false, prFeedback: false }).poll()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a COMMENTED review with a body is feedback, keyed by its id', async () => {
    stubApi([
      {
        number: 5,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 90, login: 'chris', state: 'COMMENTED', body: 'two nits inline', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'gh:o/r#pr5@rv90', subject: 'gh:o/r#pr5', kind: 'review', followUp: UUID });
  });

  it("a review-feedback brief ends with the repo's review hook", async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.demo]\npath = "/d"\n[repos.demo.hooks.brief]\nreview = "Run the review refresh."\n');
    stubApi([
      {
        number: 5,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 90, login: 'chris', state: 'COMMENTED', body: 'two nits inline', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const [item] = await source().poll();
    expect(item!.brief).toMatch(/^Address the review feedback on /);
    expect(item!.brief.endsWith('\n\nRun the review refresh.')).toBe(true);
  });

  it('CHANGES_REQUESTED counts even when reviewed on a stale sha', async () => {
    stubApi([
      {
        number: 6,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 91, login: 'chris', state: 'CHANGES_REQUESTED', sha: 'oldsha', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items.map((i) => i.key)).toEqual(['gh:o/r#pr6@rv91']);
  });

  it('claims one round for a requested-changes review and all its inline comments, across restarts', async () => {
    const pr: PrFixture = {
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'CHANGES_REQUESTED', body: 'Handle the race.', at: '2026-09-21T10:00:00Z' }],
      reviewComments: [
        { id: 40, login: 'reviewer', body: 'Lock here.', at: '2026-09-21T09:59:00Z', reviewId: 91 },
        { id: 41, login: 'reviewer', body: 'Check this too.', at: '2026-09-21T10:00:00Z', reviewId: 91 },
      ],
    };
    stubApi([pr]);
    const state = new PickupState();
    await dispatchLoop(source(), state);
    const round = state.get('gh:o/r#pr6@rv91')!;
    expect(round).toBeDefined();
    expect(pendingIds('work')).toEqual([round.uuid]);
    expect(claimNext('work')).toBe(round.uuid);
    appendStatus(round.uuid, 'work', 'done', 'addressed');
    complete(round.uuid, 'work');
    // A later API response containing the same review's comments keeps rv91.
    pr.reviewComments!.push({ id: 42, login: 'reviewer', body: 'Third finding.', at: '2026-09-21T09:59:30Z', reviewId: 91 });
    await dispatchLoop(source(), new PickupState());
    expect(pendingIds('work')).toEqual([]);
    expect(new PickupState().entries()).toHaveLength(1);
  });

  it('wakes an inline-only COMMENTED review under the review id', async () => {
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'COMMENTED', at: '2026-09-21T10:00:00Z' }],
      reviewComments: [{ id: 40, login: 'reviewer', body: 'Handle the empty case.', at: '2026-09-21T09:59:00Z', reviewId: 91 }],
    }]);
    expect((await source().poll()).map((item) => item.key)).toEqual(['gh:o/r#pr6@rv91']);
  });

  it('wakes standalone inline feedback and later replies, with a quiet interval for bursts', async () => {
    let now = Date.parse('2026-09-21T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pr: PrFixture = {
      number: 6, branch: `lobstah/${UUID}`,
      reviewComments: [{ id: 40, login: 'reviewer', body: 'Handle empty input.', at: '2026-09-21T10:00:00Z' }],
      threads: [{ root: 40, path: 'src/input.ts', line: 10 }],
    };
    stubApi([pr]);
    const state = new PickupState();
    await dispatchLoop(source(), state);
    expect(state.entries()).toHaveLength(0);
    now += 20_000;
    pr.reviewComments!.push({ id: 41, login: 'reviewer', body: 'And null.', at: '2026-09-21T10:00:20Z' });
    pr.threads!.push({ root: 41, path: 'src/input.ts', line: 11 });
    await dispatchLoop(source(), state);
    expect(state.entries()).toHaveLength(0);
    now += 30_000;
    await dispatchLoop(source(), state);
    expect(state.entries()).toHaveLength(1);
    const round = state.get('gh:o/r#pr6@rc41')!;
    expect(claimNext('work')).toBe(round.uuid);
    const brief = readDescriptor(round.uuid, 'work').brief;
    expect(brief).toContain('Handle empty input.');
    expect(brief).toContain('And null.');
    appendStatus(round.uuid, 'work', 'done');
    complete(round.uuid, 'work');
    await dispatchLoop(source(), new PickupState());
    expect(pendingIds('work')).toEqual([]);
    pr.reviews = [{ id: 91, login: 'reviewer', state: 'COMMENTED', at: '2026-09-21T09:00:00Z' }];
    pr.reviewComments!.push({ id: 42, login: 'reviewer', body: 'Still needs a check.', at: '2026-09-21T10:01:00Z', reviewId: 91, replyTo: 40 });
    now += 40_000;
    await dispatchLoop(source(), new PickupState());
    expect(new PickupState().entries()).toHaveLength(2);
    expect(new PickupState().get('gh:o/r#pr6@rc42')).toBeDefined();
  });

  it.each(['APPROVED', 'DISMISSED', 'PENDING'])('does not wake on a %s review or its inline comments', async (state) => {
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state, body: 'Review body.', at: state === 'PENDING' ? '' : '2026-09-21T10:00:00Z' }],
      reviewComments: [{ id: 40, login: 'reviewer', body: 'Inline.', at: '2026-09-21T09:59:00Z', reviewId: 91 }],
    }]);
    expect(await source().poll()).toEqual([]);
  });

  it.each([IDENTITY.toUpperCase(), 'worker'])('ignores reviews and inline comments by %s', async (login) => {
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`, author: 'worker',
      reviews: [{ id: 91, login, state: 'CHANGES_REQUESTED', at: '2026-09-21T10:00:00Z' }],
      reviewComments: [
        { id: 40, login, body: 'Own review.', at: '2026-09-21T09:59:00Z', reviewId: 91 },
        { id: 41, login, body: 'Own standalone comment.', at: '2026-09-21T10:01:00Z' },
      ],
    }]);
    expect(await source().poll()).toEqual([]);
  });

  it('puts the review body and unresolved discussions in the brief, with file, line and URL', async () => {
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'CHANGES_REQUESTED', body: 'Handle the race before merging.', at: '2026-09-21T10:00:00Z' }],
      reviewComments: [
        { id: 40, login: 'reviewer', body: 'Guard the write.', at: '2026-09-21T09:59:00Z', reviewId: 91 },
        { id: 41, login: IDENTITY, body: 'The caller serializes it.', at: '2026-09-21T10:01:00Z', replyTo: 40 },
        { id: 42, login: 'reviewer', body: 'Already resolved finding.', at: '2026-09-21T09:59:00Z', reviewId: 91 },
      ],
      threads: [
        { root: 40, path: 'src/queue.ts', line: 27 },
        { root: 42, path: 'src/old.ts', line: 4, resolved: true },
      ],
    }]);
    const [item] = await source().poll();
    expect(item!.brief).toContain('Handle the race before merging.');
    expect(item!.brief).toContain('src/queue.ts:27');
    expect(item!.brief).toContain('https://github.com/o/r/pull/6#discussion_r40');
    expect(item!.brief).toContain('reviewer: Guard the write.');
    expect(item!.brief).toContain(`${IDENTITY}: The caller serializes it.`);
    expect(item!.brief).not.toContain('Already resolved finding.');
    expect(item!.brief).not.toContain('src/old.ts');
  });

  it('reads every REST comment and thread page, including outdated and file-level anchors', async () => {
    const reviewComments = Array.from({ length: 101 }, (_, id) => ({
      id, login: 'reviewer', body: `Finding ${id}.`, at: '2026-09-21T09:59:00Z', reviewId: 91,
    }));
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'COMMENTED', at: '2026-09-21T10:00:00Z' }],
      reviewComments: [...reviewComments, { id: 101, login: IDENTITY, body: 'Last reply.', at: '2026-09-21T10:01:00Z', replyTo: 100 }],
      threads: reviewComments.map(({ id }) => ({ root: id, path: `file${id}.ts`, line: id === 100 ? null : id, ...(id === 99 ? { line: null, originalLine: 19 } : {}) })),
    }]);
    const [item] = await source().poll();
    expect(item!.key).toBe('gh:o/r#pr6@rv91');
    expect(item!.brief).toContain('file99.ts:19');
    expect(item!.brief).toContain('file100.ts — https://github.com/o/r/pull/6#discussion_r100');
    expect(item!.brief).toContain('Finding 100.');
    expect(item!.brief).toContain('Last reply.');
  });

  it('retries GraphQL failures without starting a round with incomplete context', async () => {
    const fixture: PrFixture = {
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'CHANGES_REQUESTED', body: 'Fix the race.', at: '2026-09-21T10:00:00Z' }],
    };
    stubApi([fixture]);
    const fetcher = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === '/graphql'
        ? new Response(JSON.stringify({ data: null, errors: [{ message: 'Unavailable' }] }))
        : fetcher(input, init));
    const state = new PickupState();
    await expect(dispatchLoop(source(), state)).rejects.toThrow('could not read complete review threads');
    expect(state.entries()).toEqual([]);
    stubApi([fixture]);
    await dispatchLoop(source(), state);
    expect(state.get('gh:o/r#pr6@rv91')).toBeDefined();
  });

  it('keeps bot conversation comments immediate while a review burst settles', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-21T10:00:01Z'));
    stubApi([{
      number: 6, branch: `lobstah/${UUID}`,
      reviews: [{ id: 91, login: 'reviewer', state: 'CHANGES_REQUESTED', at: '2026-09-21T10:00:00Z' }],
      issueComments: [{ id: 60, login: 'ci[bot]', body: 'CI failed.', at: '2026-09-21T10:00:01Z' }],
    }]);
    expect((await source().poll()).map((item) => item.key)).toEqual(['gh:o/r#pr6@ic60']);
  });

  it('conversation and review-thread comments are feedback; marker comments are not', async () => {
    stubApi([
      {
        number: 7,
        branch: `lobstah/${UUID}`,
        reviewComments: [
          { id: 40, login: 'chris', body: 'rename this', at: '2026-09-21T09:00:00Z' },
          { id: 41, login: IDENTITY, body: 'done, renamed', at: '2026-09-21T09:30:00Z' },
        ],
        issueComments: [
          { id: 50, login: 'chris', body: 'also update the docs', at: '2026-09-21T10:00:00Z' },
          { id: 51, login: 'chris', body: `${marker(UUID)} **done**`, at: '2026-09-21T11:00:00Z' },
        ],
      },
    ]);
    const items = await source().poll();
    expect(items.map((i) => i.key)).toEqual(['gh:o/r#pr7@ic50']);
  });

  it('a review, inline comment or comment carrying the hidden marker is not feedback', async () => {
    stubApi([
      {
        number: 12,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 95, login: 'chris', state: 'COMMENTED', body: 'looks fine\n\n<!-- lobstah:round-1 -->', at: '2026-09-21T12:00:00Z' }],
        reviewComments: [
          { id: 42, login: 'chris', body: 'rename this', at: '2026-09-21T09:00:00Z' },
          { id: 43, login: 'chris', body: `renamed\n\n<!-- lobstah:${UUID} -->`, at: '2026-09-21T11:00:00Z' },
        ],
        issueComments: [{ id: 52, login: 'chris', body: markedNote('reset'), at: '2026-09-21T13:00:00Z' }],
      },
    ]);
    expect((await source().poll()).map((i) => i.key)).toEqual(['gh:o/r#pr12@rc42']);
  });

  it('the review-feedback brief tells the worker to mark its replies', async () => {
    stubApi([{ number: 5, branch: `lobstah/${UUID}`, issueComments: [{ id: 53, login: 'chris', body: 'fix it', at: '2026-09-21T10:00:00Z' }] }]);
    const [item] = await source().poll();
    expect(item!.brief).toContain(`End every comment or reply you post on the PR with \`<!-- lobstah:${UUID} -->\``);
  });

  it("the identity's own unmarked comment on its PR is feedback", async () => {
    stubApi([
      {
        number: 13,
        branch: `lobstah/${UUID}`,
        issueComments: [
          { id: 54, login: IDENTITY, body: 'also handle the empty case', at: '2026-09-21T10:00:00Z' },
          { id: 55, login: IDENTITY, body: `${marker(UUID)} **done**`, at: '2026-09-21T11:00:00Z' },
        ],
      },
    ]);
    expect(await source().poll()).toMatchObject([{ key: 'gh:o/r#pr13@ic54', followUp: UUID }]);
  });

  it('the guard holds an identity comment made during a run, and a held-only round drops its own', async () => {
    const pr: PrFixture = {
      number: 14,
      branch: `lobstah/${UUID}`,
      issueComments: [{ id: 44, login: IDENTITY, body: 'fixed, see abc123', at: '2026-09-21T10:30:00Z' }],
    };
    stubApi([pr]);
    const runs = [{ start: '2026-09-21T10:00:00Z', end: '2026-09-21T11:00:00Z' }];
    const [held] = await source().poll({ runs: () => runs });
    expect(held).toMatchObject({ key: 'gh:o/r#pr14@ic44', heldOnly: true });

    runs.push({ start: '2026-09-21T11:05:00Z', end: '2026-09-21T11:30:00Z', heldOnly: true } as (typeof runs)[number]);
    pr.issueComments!.push({ id: 56, login: IDENTITY, body: 'nothing to change', at: '2026-09-21T11:10:00Z' });
    stubApi([pr]);
    expect((await source().poll({ runs: () => runs }))[0]).toMatchObject({ key: 'gh:o/r#pr14@ic44' });
  });

  it('a newer human event re-keys the round', async () => {
    const pr: PrFixture = {
      number: 8,
      branch: `lobstah/${UUID}`,
      reviews: [{ id: 92, login: 'chris', state: 'CHANGES_REQUESTED', at: '2026-09-21T10:00:00Z' }],
    };
    stubApi([pr]);
    expect((await source().poll())[0]!.key).toBe('gh:o/r#pr8@rv92');
    pr.issueComments = [{ id: 60, login: 'chris', body: 'one more thing', at: '2026-09-21T12:00:00Z' }];
    stubApi([pr]);
    expect((await source().poll())[0]!.key).toBe('gh:o/r#pr8@ic60');
  });

  it('maps a non-lobstah branch through reported evidence', async () => {
    fs.writeFileSync(
      path.join(laneDirs('work').state, `${UUID}.evidence`),
      JSON.stringify({ prUrl: 'https://github.com/o/r/pull/9' }),
    );
    stubApi([
      {
        number: 9,
        branch: 'feat/session-branch',
        issueComments: [{ id: 70, login: 'chris', body: 'please split this commit', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'gh:o/r#pr9@ic70', followUp: UUID });
  });

  it('an unmapped PR, an APPROVED review, and a bodyless COMMENTED review are all quiet', async () => {
    stubApi([
      {
        number: 10,
        branch: 'feat/unrelated',
        issueComments: [{ id: 80, login: 'chris', body: 'nice', at: '2026-09-21T10:00:00Z' }],
      },
      {
        number: 11,
        branch: `lobstah/${UUID}`,
        reviews: [
          { id: 93, login: 'chris', state: 'APPROVED', body: 'ship it', at: '2026-09-21T10:00:00Z' },
          { id: 94, login: 'chris', state: 'COMMENTED', body: '  ', at: '2026-09-21T11:00:00Z' },
        ],
      },
    ]);
    expect(await source().poll()).toEqual([]);
  });
});

describe('the active-round guard', () => {
  const ev = (tag: string, at: string, own = true) => ({ tag, at: `2026-10-15T${at}:00Z`, own });
  const run = (start: string, end?: string, heldOnly?: boolean) => ({
    start: `2026-10-15T${start}:00Z`,
    ...(end ? { end: `2026-10-15T${end}:00Z` } : {}),
    ...(heldOnly ? { heldOnly } : {}),
  });

  it('an identity comment outside every run counts at once', () => {
    expect(guardFeedback([ev('ic1', '09:00')], [run('08:00', '08:30')])).toEqual({ tag: 'ic1', heldOnly: false });
  });

  it('an identity comment inside a run is held: it opens a held-only round', () => {
    expect(guardFeedback([ev('ic1', '08:10')], [run('08:00')])).toEqual({ tag: 'ic1', heldOnly: true });
    expect(guardFeedback([ev('ic1', '08:10')], [run('08:00', '08:30')])).toEqual({ tag: 'ic1', heldOnly: true });
  });

  it("a held-only round drops the identity's comments made during it, never anyone else's", () => {
    const runs = [run('08:00', '08:30'), run('08:40', '09:00', true)];
    expect(guardFeedback([ev('ic1', '08:10'), ev('ic2', '08:50')], runs)).toEqual({ tag: 'ic1', heldOnly: false }); // ic1 already opened the held-only round
    expect(guardFeedback([ev('ic1', '08:10'), ev('ic3', '08:55', false)], runs)).toEqual({ tag: 'ic3', heldOnly: false });
  });

  it('a round is held-only only when every event since the latest run started is held', () => {
    expect(guardFeedback([ev('ic1', '08:10'), ev('rv2', '08:20', false)], [run('08:00')])).toEqual({ tag: 'rv2', heldOnly: false });
    expect(guardFeedback([], [run('08:00')])).toBeUndefined();
  });
});

describe('markers', () => {
  it('a marked note carries the dispatch marker when one backs it, else the hidden one', () => {
    expect(markedNote('rebase failed', UUID)).toBe(`[lobstah:${UUID}] rebase failed`);
    expect(markedNote('reset')).toBe('reset\n\n<!-- lobstah -->');
    for (const body of [markedNote('x', UUID), markedNote('x'), 'ok <!-- lobstah:review r1 -->']) expect(lobstahWrote(body)).toBe(true);
    for (const body of ['plain', '[lobstah:short]', '<!-- lobstahx -->', null, undefined]) expect(lobstahWrote(body)).toBe(false);
  });
});

describe('key ownership', () => {
  it('owns its own issue and review keys, nothing else', () => {
    const s = source();
    expect(s.owns('gh:o/r#12')).toBe(true);
    expect(s.owns('gh:o/r#pr12@rv5252340326')).toBe(true);
    expect(s.owns('linear:BAS-534')).toBe(false);
    expect(s.owns('gh:o/r2#12')).toBe(false); // a second repo's source
  });
});

describe('review re-request', () => {
  it('posts requested reviewers for the PR and drops its author', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ method: init?.method ?? 'GET', path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return new Response(JSON.stringify(path.endsWith('/requested_reviewers') ? {} : { user: { login: 'Author' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    await source().requestReview(17, ['alice', 'Author', 'bob', 'alice']);
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/o/r/pulls/17' },
      { method: 'POST', path: '/repos/o/r/pulls/17/requested_reviewers', body: { reviewers: ['alice', 'bob'] } },
    ]);
  });
});
