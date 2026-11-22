import * as fs from 'node:fs';
import * as path from 'node:path';
import { latestRound, observeReviewRequest, readReview, reviewRoundDir, reviewStateHash, writeReview } from '@lobstah/core';
import type { TendAttention } from '@lobstah/core';

export const REVIEW_KEY = 'review:acme/web#42';
export const HEAD = 'aaaaaaa1';

/** A drafted round of acme/web#42 at head aaaaaaa1, as a review job leaves it, with the given verdict. */
export function draftReview(verdict: 'approve' | 'request_changes' | 'comment', repoKey = 'web'): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 42, url: 'https://github.com/acme/web/pull/42', title: 'Retry the checkout webhook', author: 'dana', headSha: HEAD, repoKey },
    round: { id: 'RR_42', requestedAt: '2026-11-21T09:00:00Z', requestedBy: 'dana' },
  });
  const dir = reviewRoundDir(REVIEW_KEY, 'RR_42')!;
  fs.mkdirSync(dir, { recursive: true });
  const blocking = verdict === 'request_changes' ? [{ path: 'src/webhook.ts', line: 30, body: 'A retry after a timeout charges the card twice.' }] : [];
  fs.writeFileSync(path.join(dir, 'review.md'), verdict === 'approve' ? '' : 'The retry loop reads well.\nOne blocker: a retry can charge twice.\n\nDetails inline.\n');
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(verdict === 'approve' ? [] : [{ path: 'src/webhook.ts', line: 12, body: 'Name this backoff constant.' }]));
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict, blocking }));
  const item = readReview(REVIEW_KEY)!;
  Object.assign(item.rounds[0]!, { state: 'drafted', dispatch: 'd1', draftedAt: '2026-11-21T09:20:00Z', verdict });
  writeReview(item);
}

/** What this boat's attention shows for the review: its key and the state it stands on. */
export function reviewShown(): TendAttention[] {
  const item = readReview(REVIEW_KEY)!;
  return [{ kind: 'review', key: REVIEW_KEY, stateHash: reviewStateHash(item), id: REVIEW_KEY, lane: 'chore', verb: 'needs-you', ageSecs: 60,
    note: 'Draft ready (needs you): acme/web#42', repo: item.pr.repoKey, prUrl: item.pr.url, number: 42, headSha: latestRound(item)!.headSha }];
}

/** A PR head observed after the draft: a push landed since. */
export function pushAfterDraft(): void {
  const item = readReview(REVIEW_KEY)!;
  item.pr.headSha = 'bbbbbbb2';
  writeReview(item);
}

export interface Call { method: string; url: string; body?: Record<string, unknown> }
/** A fake GitHub for the PR's reviews: none posted yet, the PR open at `head`, and a create that answers with id 99. */
export function github(calls: Call[], head = HEAD) {
  return async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (init.method === 'GET' && /\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ head: { sha: head }, state: 'open' }));
    if (init.method === 'GET') return new Response('[]');
    return new Response(JSON.stringify({ id: 99 }));
  };
}
