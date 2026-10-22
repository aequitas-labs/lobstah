import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackendError, ensureLayout, latestRound, observeReviewRequest, pendingIds, readReview, reviewAttention, reviewRoundDir, writeReview } from '@lobstah/core';
import { claimReviewDocs, publishReviewDocs, reviewDocId, runReviewRequests } from '../src/reviews-wharf.js';
import type { ReviewWharf } from '../src/reviews-wharf.js';
import { draftReviews, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-wharf-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      '[reviews]',
      'enabled = true',
      'work = "headless"',
      '[repos.web]',
      'path = "/w"',
      'origin = "git@github.com:acme/web.git"',
      '[wharves.cloud]',
      "url = 'https://state.invalid'",
      "account = 'person'",
      "tokenEnv = 'REVIEWS_TEST_BOAT'",
      '[grounds.away]',
      "repos = ['web']",
      "wharf = 'cloud'",
    ].join('\n'),
  );
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const KEY = 'review:acme/web#7';
const DOC = reviewDocId(KEY, 'RRE_7');

function request(): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Add the thing', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' },
    round: { id: 'RRE_7', requestedAt: '2026-10-15T09:00:00Z', requestedBy: 'dana' },
  });
}

interface Call {
  path: string;
  body?: unknown;
}
/** A fake wharf: records requests and uploads; `create` decides the document's creation. */
function wharf(calls: Call[], opts: { create?: 'ok' | 'taken'; requests?: unknown[] } = {}): () => ReviewWharf {
  let file = 0;
  return () => ({
    async request(p: string, body?: unknown) {
      calls.push({ path: p, ...(body !== undefined ? { body } : {}) });
      if (p === 'documents' && opts.create === 'taken') throw new BackendError(409, 'document already exists');
      if (p === 'requests/reviews') return opts.requests ?? [];
      return {};
    },
    async uploadDocument(id: string, name: string, bytes: Uint8Array) {
      calls.push({ path: `documents/${id}/files`, body: { name, text: new TextDecoder().decode(bytes) } });
      return `f${++file}`;
    },
  });
}

describe('review documents on wharf grounds', () => {
  it.each([undefined, { login: 'maya', name: 'Maya Maintainer' }])('publishes the real asker after a bot request', async (humanRequester) => {
    request();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { requestedBy: 'github-actions[bot]', requestedAutomatically: true, humanRequester, wharf: { doc: DOC, mine: true } });
    writeReview(item);
    const calls: Call[] = [];
    await publishReviewDocs(() => {}, { backend: wharf(calls) });
    const asker = humanRequester?.login ?? 'dana';
    expect((calls[0]!.body as { text: string }).text).toContain(`${asker} asked for this review.`);
    expect(calls[1]!.body).toMatchObject({ review: { requestedBy: asker } });
  });
  it('the boat that creates the round document drafts it; a boat that gets a 409 drafts nothing', async () => {
    request();
    const calls: Call[] = [];
    draftReviews('chris', () => {}, Date.now());
    expect(pendingIds('chore')).toEqual([]); // no document yet: no job
    await claimReviewDocs(() => {}, { backend: wharf(calls, { create: 'taken' }) });
    expect(calls[0]).toMatchObject({ path: 'documents', body: { id: DOC, kind: 'review', review: { pr: 'https://github.com/acme/web/pull/7', round: 'RRE_7', state: 'requested' } } });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ wharf: { doc: DOC, mine: false }, reason: expect.stringContaining('another boat') });
    draftReviews('chris', () => {}, Date.now());
    expect(pendingIds('chore')).toEqual([]);
    expect(reviewAttention(Date.now())).toEqual([]); // the other boat's to show, not this one's

    const item = readReview(KEY)!;
    delete item.rounds[0]!.wharf;
    delete item.rounds[0]!.reason;
    writeReview(item);
    await claimReviewDocs(() => {}, { backend: wharf(calls) });
    expect(latestRound(readReview(KEY)!)!.wharf).toEqual({ doc: DOC, mine: true });
    draftReviews('chris', () => {}, Date.now());
    expect(pendingIds('chore')).toHaveLength(1);
  });

  it('publishes the state and the review-tool link, and again only when they change', async () => {
    fs.appendFileSync(path.join(home, 'config.toml'), '');
    fs.writeFileSync(path.join(home, 'config.toml'), fs.readFileSync(path.join(home, 'config.toml'), 'utf8').replace('origin = "git@github.com:acme/web.git"', 'origin = "git@github.com:acme/web.git"\nreviewTool = "graphite"'));
    request();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state: 'drafted', dispatch: 'd1', staged: { reviewId: '77', at: 'x' }, wharf: { doc: DOC, mine: true } });
    writeReview(item);
    const calls: Call[] = [];
    await publishReviewDocs(() => {}, { backend: wharf(calls) });
    expect(calls.map((c) => c.path)).toEqual([`documents/${DOC}/files`, `documents/${DOC}/publish`]);
    expect((calls[0]!.body as { text: string }).text).toContain('pending review on the PR');
    expect(calls[1]!.body).toMatchObject({ markdown: 'f1', review: { state: 'drafted', stands: true, requestedBy: 'dana', open: 'https://app.graphite.com/github/pr/acme/web/7' } });
    await publishReviewDocs(() => {}, { backend: wharf(calls) });
    expect(calls).toHaveLength(2);
    const posted = readReview(KEY)!;
    posted.rounds[0]!.state = 'posted';
    writeReview(posted);
    await publishReviewDocs(() => {}, { backend: wharf(calls) });
    expect(calls.at(-1)!.body).toMatchObject({ review: { state: 'posted', stands: false } });
  });

  it("carries out a hosted Dismiss with the boat's own dismiss, and refuses a review it does not have", async () => {
    request();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state: 'drafted', wharf: { doc: DOC, mine: true } });
    writeReview(item);
    const calls: Call[] = [];
    const dismissed: string[] = [];
    await runReviewRequests(() => {}, {
      backend: wharf(calls, { requests: [{ id: 'q1', kind: 'review-dismiss', document: DOC }, { id: 'q2', kind: 'review-dismiss', document: 'rv-elsewhere' }] }),
      dismiss: async (key) => (dismissed.push(key), undefined),
    });
    expect(dismissed).toEqual([KEY]);
    expect(calls.filter((c) => c.path.startsWith('requests/q'))).toEqual([
      { path: 'requests/q1/start', body: {} },
      { path: 'requests/q2/start', body: { refused: 'this boat has no such review' } },
    ]);
  });

  it('a wharf-grounds pick cycle with a drafted round publishes one review document', async () => {
    request();
    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state: 'drafted', dispatch: 'd1', staged: { reviewId: '77', at: 'x' }, wharf: { doc: DOC, mine: true } });
    writeReview(item);
    const search: GhGraphql = () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [] } } }) });
    const calls: Call[] = [];
    await reviewsLoop('chris', () => 'token', () => {}, { run: search, wharf: { backend: wharf(calls) } });
    expect(calls.filter((c) => c.path.endsWith('/publish'))).toHaveLength(1);
  });
});
