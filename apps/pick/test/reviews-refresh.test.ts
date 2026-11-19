import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus, claimNext, complete, ensureLayout, latestRound, observeReviewRequest,
  pendingIds, readReview, requestCancel, reviewCanPublish, reviewRoundDir, reviewStands, writeReview,
  loadConfig, refreshReviewNotifications,
} from '@lobstah/core';
import { draftReviews, refreshReviewDrafts, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import type { FetchLike } from '../src/reviews-post.js';
import { REVIEW_DECISIONS } from '../../../test/review-decisions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const KEY = 'review:acme/web#7';
const NOW = Date.parse('2026-11-19T12:00:00Z');
const truncated: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [] } } }) });
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-refresh-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\nmode = "on-demand"\nmaxPerDay = 0\n[repos.web]\npath = "/w"\n');
  observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Preserve preferences', author: 'dana', headSha: 'new-head', repoKey: 'web' },
    round: { id: 'round-7', requestedAt: new Date(NOW - 60_000).toISOString() } }, NOW);
  const item = readReview(KEY)!;
  Object.assign(latestRound(item)!, { state: 'stale', headSha: 'old-head', staged: { reviewId: '77', at: new Date(NOW - 60_000).toISOString() } });
  writeReview(item);
});
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });
const round = () => latestRound(readReview(KEY)!)!;

/** Complete the queued job without launching a harness or contacting GitHub. */
function finish(verdict: 'approve' | 'request_changes' = 'approve'): void {
  const id = claimNext('chore')!;
  const directory = reviewRoundDir(KEY, round().id)!;
  fs.writeFileSync(path.join(directory, 'review.md'), 'Current findings');
  fs.writeFileSync(path.join(directory, 'comments.json'), '[]');
  fs.writeFileSync(path.join(directory, 'verdict.json'), JSON.stringify({ verdict, blocking: verdict === 'approve' ? [] : [{ path: 'code.ts', line: 2, body: 'Preserve the write.' }] }));
  appendStatus(id, 'chore', 'done', 'draft ready');
  complete(id, 'chore');
}

it('automatically redrafts a stale on-demand review at the new head, even after the automatic daily cap', async () => {
  await refreshReviewDrafts({ now: NOW });
  expect(round()).toMatchObject({ state: 'requested', headSha: 'new-head', manualPublishOnly: true, localRequest: true, pendingReview: { reviewId: '77' } });
  expect(reviewStands(round())).toBe(false);
  expect(refreshReviewNotifications(NOW)).toEqual([]);
  draftReviews('chris', () => {}, NOW);
  const dispatch = round().dispatch;
  expect(round()).toMatchObject({ state: 'drafting', draftOnly: true, publish: false, autoPostApprove: 'ask', autoPostRequestChanges: 'ask' });
  await refreshReviewDrafts({ now: NOW }); draftReviews('chris', () => {}, NOW);
  expect(pendingIds('chore')).toEqual([dispatch]);
});

it.each(['approve', 'request_changes'] as const)('stages repaired %s drafts and requires a click even if automatic posting is enabled', async verdict => {
  await refreshReviewDrafts({ now: NOW }); draftReviews('chris', () => {}, NOW); finish(verdict);
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[repos.web.reviews]\nmode = "auto-review"\nautoPostApprove = "auto-post"\nautoPostRequestChanges = "auto-post"\n');
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: FetchLike = async (url, init) => {
    if (init.method === 'GET') return new Response('[]');
    writes.push({ url, body: JSON.parse(init.body!) });
    return new Response('{"id":99}');
  };
  await reviewsLoop('chris', () => 'fixture', () => {}, { run: truncated, fetch: fetcher, now: NOW + 1000 });
  expect(round()).toMatchObject({ state: 'drafted', staged: { reviewId: '99' }, manualPublishOnly: true });
  expect(round().refresh).toBeUndefined();
  expect(reviewCanPublish(loadConfig().reviews, 'web', round(), verdict)).toBe(false);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.url).toMatch(/\/reviews$/);
  expect(writes[0]!.body).not.toHaveProperty('event');
});

it('automatically redrafts staging failures with persisted backoff and no attention notice', async () => {
  const item = readReview(KEY)!;
  Object.assign(latestRound(item)!, { state: 'drafted', reason: 'stage failed: line not in diff' }); writeReview(item);
  await refreshReviewDrafts({ now: NOW });
  expect(round()).toMatchObject({ state: 'requested', refresh: { attempts: 1, retryAt: new Date(NOW + 30_000).toISOString() } });
  draftReviews('chris', () => {}, NOW + 29_999); expect(pendingIds('chore')).toEqual([]);
  expect(refreshReviewNotifications(NOW)).toEqual([]);
  draftReviews('chris', () => {}, NOW + 30_000); expect(pendingIds('chore')).toHaveLength(1);
  const failed = readReview(KEY)!; latestRound(failed)!.state = 'failed';
  const id = claimNext('chore')!; appendStatus(id, 'chore', 'failed', 'draft failed'); complete(id, 'chore'); writeReview(failed);
  await refreshReviewDrafts({ now: NOW + 31_000 });
  expect(round().refresh).toMatchObject({ attempts: 2, retryAt: new Date(NOW + 91_000).toISOString() });
});

it.each(['muted', 'closed', 'dismissed'])('does not repair a %s review', async state => {
  const item = readReview(KEY)!;
  if (state === 'muted') item.mutedAt = new Date(NOW).toISOString();
  if (state === 'closed') item.pr.state = 'CLOSED';
  if (state === 'dismissed') latestRound(item)!.state = 'dismissed';
  writeReview(item);
  await refreshReviewDrafts({ now: NOW });
  expect(round().refresh).toBeUndefined(); expect(pendingIds('chore')).toEqual([]);
});

it('waits for an active stale draft to stop before replacing its files', async () => {
  await refreshReviewDrafts({ now: NOW }); draftReviews('chris', () => {}, NOW);
  const id = claimNext('chore')!;
  const item = readReview(KEY)!; latestRound(item)!.state = 'stale'; item.pr.headSha = 'newer-head'; writeReview(item);
  await refreshReviewDrafts({ now: NOW + 1000 });
  expect(round().dispatch).toBe(id); expect(round().state).toBe('stale'); expect(pendingIds('chore')).toEqual([]);
  appendStatus(id, 'chore', 'failed', 'cancelled'); complete(id, 'chore');
  await refreshReviewDrafts({ now: NOW + 2000 });
  expect(round()).toMatchObject({ state: 'requested', headSha: 'newer-head' });
});

it('respects a person cancelling an automatic refresh', async () => {
  await refreshReviewDrafts({ now: NOW }); draftReviews('chris', () => {}, NOW);
  const id = claimNext('chore')!; requestCancel(id, 'chore');
  const item = readReview(KEY)!; latestRound(item)!.state = 'stale'; writeReview(item);
  await refreshReviewDrafts({ now: NOW + 1000 });
  expect(round()).toMatchObject({ state: 'failed', reason: 'the review job was cancelled' });
  expect(round().refresh).toBeUndefined();
});

it('repairs a new request round opened by changed PR commits, without waiting for another Draft click', () => {
  const item = readReview(KEY)!;
  Object.assign(item.pr, { headSha: 'old-head', diffId: 'old-diff' });
  Object.assign(latestRound(item)!, { state: 'drafted', diffId: 'old-diff', draftedAt: new Date(NOW - 10_000).toISOString() });
  writeReview(item);
  observeReviewRequest({ pr: { ...item.pr, headSha: 'new-head', diffId: 'new-diff' },
    round: { id: 'round-7', requestedAt: new Date(NOW - 60_000).toISOString() } }, NOW);
  expect(readReview(KEY)!.rounds).toHaveLength(2);
  expect(round()).toMatchObject({ state: 'requested', refresh: { attempts: 1 }, manualPublishOnly: true, pendingReview: { reviewId: '77' } });
  draftReviews('chris', () => {}, NOW + 30_000);
  expect(round()).toMatchObject({ state: 'drafting', headSha: 'new-head', publish: false });
});


it('ends the quiet update when a fresh draft needs a product decision, without submitting it', async () => {
  await refreshReviewDrafts({ now: NOW }); draftReviews('chris', () => {}, NOW); finish();
  fs.writeFileSync(path.join(reviewRoundDir(KEY, round().id)!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [], decisions: REVIEW_DECISIONS }));
  draftReviews('chris', () => {}, NOW + 1000);
  expect(round().state).toBe('drafted'); expect(round().refresh).toBeUndefined();
  expect(round().manualPublishOnly).toBe(true); expect(round().decisions).toEqual(REVIEW_DECISIONS);
  expect(refreshReviewNotifications(NOW + 1000)).toHaveLength(1);
});
