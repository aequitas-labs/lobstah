import { describe, expect, it } from 'vitest';
import { derivePrEvents, parsePrRef, parseUnresolvedThreads, PR_VIEW_FIELDS, prBadge, prEvidence, prReview } from '../src/pr.js';
import type { GhPrView, PrEvidence } from '../src/pr.js';

const ref = parsePrRef('pr:acme/web#26')!;
const SHA = 'b44dd399fd98058cc8f124054b0b49aae3655c82';

// Fixture gh snapshots, shaped like `gh pr view --json` output.
const run = (name: string, conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://ci/${name}`,
});
const open: GhPrView = {
  state: 'OPEN',
  isDraft: false,
  headRefOid: SHA,
  mergeStateStatus: 'BLOCKED',
  reviewDecision: '',
  statusCheckRollup: [run('test (ubuntu)', 'SUCCESS'), run('test (windows)', null, 'IN_PROGRESS')],
};
const failedAndReviewed: GhPrView = {
  ...open,
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [run('test (ubuntu)', 'SUCCESS'), run('test (windows)', 'FAILURE')],
};
const merged: GhPrView = { ...failedAndReviewed, state: 'MERGED', mergeStateStatus: 'UNKNOWN', mergedAt: '2026-09-23T03:00:00Z' };

describe('parsePrRef', () => {
  it('normalizes a key, a bare ref, and a PR URL to the same watch key', () => {
    for (const s of ['pr:acme/web#26', 'acme/web#26', 'https://github.com/acme/web/pull/26', 'https://github.com/acme/web/pull/26/files']) {
      expect(parsePrRef(s)?.key).toBe('pr:acme/web#26');
    }
    expect(parsePrRef('https://gitlab.com/acme/web/-/merge_requests/3')).toBeUndefined();
  });
});

describe('PR stack branch evidence', () => {
  it('reads both branch names in the existing view call and stamps them', () => {
    expect(PR_VIEW_FIELDS.split(',')).toEqual(expect.arrayContaining(['baseRefName', 'headRefName']));
    const pr = prEvidence(ref, { ...open, baseRefName: 'main', headRefName: 'glass' }, '2026-09-23T13:00:00Z');
    expect(pr).toMatchObject({ baseRefName: 'main', headRefName: 'glass' });
  });
});

describe('derivePrEvents', () => {
  it('first observation: completed checks only; merge state and draft are baseline', () => {
    const r = derivePrEvents(ref, open, '0');
    expect(r.events.map((e) => [e.kind, e.name])).toEqual([['check-completed', 'test (ubuntu)']]);
    expect(r.events[0]!.notice).toBe(true); // green is evidence, not work
    expect(r.events[0]!.headSha).toBe(SHA);
    expect(r.done).toBe(false);
  });

  it('a check flipping to FAILURE and a review decision each emit one event, carrying the head sha', () => {
    const first = derivePrEvents(ref, open, '0');
    const second = derivePrEvents(ref, failedAndReviewed, first.cursor);
    expect(second.events.map((e) => e.kind)).toEqual(['check-completed', 'review-decision']);
    const [check, review] = second.events;
    expect(check).toMatchObject({ name: 'test (windows)', conclusion: 'FAILURE', detailsUrl: 'https://ci/test (windows)', headSha: SHA, notice: false });
    expect(review).toMatchObject({ value: 'CHANGES_REQUESTED', headSha: SHA });
    expect(second.cursor).not.toBe(first.cursor);
  });

  it('an unchanged PR emits nothing and returns the same cursor', () => {
    const first = derivePrEvents(ref, failedAndReviewed, '0');
    const again = derivePrEvents(ref, failedAndReviewed, first.cursor);
    expect(again.events).toEqual([]);
    expect(again.cursor).toBe(first.cursor);
  });

  it('replaying the same cursor yields the same seqs (dedupe-safe)', () => {
    const c = derivePrEvents(ref, open, '0').cursor;
    const a = derivePrEvents(ref, failedAndReviewed, c).events.map((e) => e.seq);
    const b = derivePrEvents(ref, failedAndReviewed, c).events.map((e) => e.seq);
    expect(a).toEqual(b);
  });

  it('merged emits one merged event and retires the watch; a re-run stays done and quiet', () => {
    const c = derivePrEvents(ref, failedAndReviewed, '0').cursor;
    const m = derivePrEvents(ref, merged, c);
    expect(m.events.map((e) => e.kind)).toEqual(['merged']);
    expect(m.done).toBe(true);
    const again = derivePrEvents(ref, merged, m.cursor);
    expect(again).toMatchObject({ events: [], done: true, cursor: m.cursor });
  });

  it('draft and merge-state flips are notices; a new head re-reports the same failing check', () => {
    const c = derivePrEvents(ref, failedAndReviewed, '0').cursor;
    const flipped = derivePrEvents(ref, { ...failedAndReviewed, isDraft: true, mergeStateStatus: 'DIRTY' }, c);
    expect(flipped.events.map((e) => [e.kind, e.notice])).toEqual([
      ['merge-state', true],
      ['draft', true],
    ]);
    const pushed = derivePrEvents(ref, { ...failedAndReviewed, headRefOid: 'c0ffee0000' }, c);
    expect(pushed.events.filter((e) => e.kind === 'check-completed').map((e) => e.name)).toEqual(['test (ubuntu)', 'test (windows)']);
  });

  it('a closed-without-merge PR emits closed and retires', () => {
    const c = derivePrEvents(ref, open, '0').cursor;
    const r = derivePrEvents(ref, { ...open, state: 'CLOSED', closedAt: '2026-09-23T03:00:00Z' }, c);
    expect(r.events.map((e) => e.kind)).toEqual(['closed']);
    expect(r.done).toBe(true);
  });
});

describe('prBadge — one derivation for tend, catch, and glass', () => {
  const at = '2026-09-23T03:00:00Z';
  const ev = (v: Partial<GhPrView>): PrEvidence => prEvidence(ref, { ...open, ...v }, at);
  const green = { statusCheckRollup: [run('a', 'SUCCESS'), run('b', 'SKIPPED')] };
  it.each([
    ['merged', ev({ ...green, state: 'MERGED' }), 'merged', 'ok', 'merged'],
    ['closed', ev({ ...green, state: 'CLOSED' }), 'closed', 'bad', 'closed'],
    ['draft', ev({ ...green, isDraft: true }), 'draft', 'dim', 'draft'],
    ['failed checks', ev(failedAndReviewed), 'checks 1/2 failed', 'bad', 'open'],
    ['changes requested', ev({ ...green, reviewDecision: 'CHANGES_REQUESTED' }), 'changes requested', 'bad', 'open'],
    ['pending checks', ev({}), 'checks 1/2', 'warn', 'open'],
    ['unresolved threads', { ...ev({ ...green }), review: { unresolvedThreads: 2, changesRequested: false } }, '2 unresolved', 'warn', 'open'],
    ['changes requested by a reviewer', { ...ev({ ...green }), review: { changesRequested: true } }, 'changes requested', 'bad', 'open'],
    ['conflicts', ev({ ...green, mergeStateStatus: 'DIRTY' }), 'conflicts', 'bad', 'open'],
    ['review required', ev({ ...green, reviewDecision: 'REVIEW_REQUIRED' }), 'review', 'warn', 'open'],
    ['green', ev({ ...green, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }), 'green', 'ok', 'open'],
  ])('%s', (_label, pr, text, tone, state) => {
    expect(prBadge(pr)).toEqual({ text, tone, state });
  });

  it('counts checks, with a StatusContext judged by its state', () => {
    const pr = ev({ statusCheckRollup: [run('a', 'SUCCESS'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }, run('c', 'TIMED_OUT')] });
    expect(pr.checks).toEqual({ total: 3, passed: 1, failed: 1, pending: 1 });
  });
});

describe('review fields (gh pr view reviews + the reviewThreads GraphQL count)', () => {
  // Fixture shapes as gh 2.83 returns them (bodies present in the real output, never read).
  const reviews = [
    { author: { login: 'ana' }, state: 'COMMENTED', submittedAt: '2026-09-23T10:00:00Z', body: 'nit' },
    { author: { login: 'bo' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-23T11:00:00Z', body: 'please fix' },
    { author: { login: 'ana' }, state: 'APPROVED', submittedAt: '2026-09-23T12:00:00Z', body: '' },
  ];
  const graphql = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: true }] } } } },
  });

  it('counts one unresolved thread and stamps it with changesRequested and lastReviewAt — no bodies', () => {
    expect(parseUnresolvedThreads(graphql)).toBe(1);
    const view: GhPrView = { ...open, reviews, unresolvedThreads: parseUnresolvedThreads(graphql) };
    const pr = prEvidence(ref, view, '2026-09-23T13:00:00Z');
    expect(pr.review).toEqual({ unresolvedThreads: 1, changesRequested: true, lastReviewAt: '2026-09-23T12:00:00Z' });
    expect(JSON.stringify(pr)).not.toContain('please fix');
  });

  it("a reviewer's later approval clears their changes request; reviewDecision alone also counts", () => {
    const later = [...reviews, { author: { login: 'bo' }, state: 'APPROVED', submittedAt: '2026-09-23T14:00:00Z' }];
    expect(prReview({ ...open, reviews: later }).changesRequested).toBe(false);
    expect(prReview({ ...open, reviews: [], reviewDecision: 'CHANGES_REQUESTED' }).changesRequested).toBe(true);
  });

  it('a failed or odd GraphQL answer omits unresolvedThreads rather than guessing', () => {
    expect(parseUnresolvedThreads('not json')).toBeUndefined();
    expect(parseUnresolvedThreads(JSON.stringify({ errors: [{ message: 'nope' }] }))).toBeUndefined();
    expect(prReview({ ...open, reviews })).toEqual({ changesRequested: true, lastReviewAt: '2026-09-23T12:00:00Z' });
  });

  it('gh pr view requests reviews in the same call', () => {
    expect(PR_VIEW_FIELDS.split(',')).toContain('reviews');
  });
});
