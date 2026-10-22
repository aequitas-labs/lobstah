import { createHash } from 'node:crypto';
import { BackendError, backendScopes, latestRound, listReviews, loadConfig, prReviewUrl, reviewStands, wharfFor, writeReview, reviewAsker } from '@lobstah/core';
import type { BackendScope, ReviewItem, ReviewRound, WharfHumanRequest } from '@lobstah/core';
import { dismissReviewRound } from './reviews-post.js';

/**
 * Review requests on wharf grounds. The boat that finds a request keeps it:
 * it creates the round's review document (the id is derived from the item
 * and round, so a second boat that found the same round gets a 409 and
 * leaves the round to the first), and publishes every state change to it
 * with the link that opens the PR in the repo's review tool, where the
 * staged draft is sent. The one thing a person asks of it from the hosted
 * glass is Dismiss, which the boat carries out with its own token (it
 * deletes the pending draft). The wharf never calls GitHub.
 */

export type ReviewWharf = { request(path: string, body?: unknown, key?: string, method?: string): Promise<unknown>; uploadDocument(id: string, name: string, bytes: Uint8Array, key: string): Promise<string> };
export interface ReviewWharfOptions {
  backend?: (scope: BackendScope) => ReviewWharf;
  /** Dismiss a round (deleting its pending review); pick's dismissReviewRound by default. */
  dismiss?: (key: string) => Promise<string | undefined>;
  now?: number;
}

const sha = (s: string, n = 32) => createHash('sha1').update(s).digest('hex').slice(0, n);

/** The round's review document id: the same on every boat that finds the round. */
export function reviewDocId(key: string, roundId: string): string {
  return `rv-${sha(`${key}\n${roundId}`)}`;
}

/** The wharf grounds a review item belongs to: the one whose repos hold its repo. Local grounds and unconfigured repos have none. */
export function reviewScope(item: ReviewItem, scopes: BackendScope[] = backendScopes(loadConfig())): BackendScope | undefined {
  const repo = item.pr.repoKey;
  return repo ? scopes.find((s) => s.kind === 'wharf' && s.repos.includes(repo)) : undefined;
}

function saveRound(item: ReviewItem, round: ReviewRound, patch: Partial<ReviewRound>, now: number): void {
  Object.assign(round, patch);
  writeReview({ ...item, updatedAt: new Date(now).toISOString() });
}

/**
 * Claim each new round on wharf grounds by creating its document. A 409
 * means another boat created it first: this boat drafts nothing and posts
 * nothing for that round.
 */
export async function claimReviewDocs(log: (m: string) => void = () => {}, opts: ReviewWharfOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const scopes = backendScopes(loadConfig());
  for (const item of listReviews()) {
    const r = latestRound(item);
    const scope = r && !r.wharf && r.state === 'requested' ? reviewScope(item, scopes) : undefined;
    if (!r || !scope) continue;
    const doc = reviewDocId(item.key, r.id);
    try {
      await (opts.backend ?? wharfFor)(scope).request('documents', { id: doc, kind: 'review', title: title(item), review: meta(item, r) }, `${doc}-create`);
      saveRound(item, r, { wharf: { doc, mine: true } }, now);
      log(`${item.key}: review document ${doc} on ${scope.wharf}`);
    } catch (err) {
      if (err instanceof BackendError && err.status === 409) {
        saveRound(item, r, { wharf: { doc, mine: false }, reason: `another boat on ${scope.wharf} has this review (document ${doc})` }, now);
        log(`${item.key}: another boat has this round's review`);
      } else log(`${item.key}: review document not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const title = (item: ReviewItem) => `${item.pr.owner}/${item.pr.repo}#${item.pr.number} ${item.pr.title}`.slice(0, 200);

/** The PR in the repo's review tool ([repos.<key>].reviewTool): where the hosted glass sends a person. */
function reviewLink(item: ReviewItem): string {
  const tool = item.pr.repoKey ? loadConfig().repos[item.pr.repoKey]?.reviewTool : undefined;
  return tool ? prReviewUrl(item.pr.url, { [`${item.pr.owner}/${item.pr.repo}`.toLowerCase()]: tool }) : item.pr.url;
}

function meta(item: ReviewItem, r: ReviewRound) {
  return {
    pr: item.pr.url,
    open: reviewLink(item),
    round: r.id,
    state: r.state,
    stands: reviewStands(r),
    headSha: r.headSha,
    requestedBy: reviewAsker(item, r).login,
    ...(r.reason ? { reason: r.reason.slice(0, 500) } : {}),
  };
}

/** What the document shows: where the round is. The draft itself waits on the PR, as the person's pending review. */
function content(item: ReviewItem, r: ReviewRound): { markdown: string } {
  const asked = `${reviewAsker(item, r).login} asked for this review.`;
  const where = r.staged ? 'The draft is your pending review on the PR: open it in your review tool to edit and send it.' : `It is ${r.state}${r.reason ? `: ${r.reason}` : ''}.`;
  return { markdown: `${asked} ${where}\n\n${reviewLink(item)}\n` };
}

/**
 * Publish each of this boat's review documents whose round changed since it
 * was last published: its state, and the link to the review tool.
 */
export async function publishReviewDocs(log: (m: string) => void = () => {}, opts: ReviewWharfOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const scopes = backendScopes(loadConfig());
  for (const item of listReviews()) {
    const r = latestRound(item);
    const scope = r?.wharf?.mine ? reviewScope(item, scopes) : undefined;
    if (!r?.wharf || !scope) continue;
    const c = content(item, r);
    const m = meta(item, r);
    const print = sha(JSON.stringify([c, m]), 16);
    if (r.wharf.published === print) continue;
    const doc = r.wharf.doc;
    try {
      const backend = (opts.backend ?? wharfFor)(scope);
      const markdown = await backend.uploadDocument(doc, 'review.md', new TextEncoder().encode(c.markdown), `${doc}-${print}-md`);
      await backend.request(`documents/${doc}/publish`, { markdown, review: m }, `${doc}-${print}-publish`);
      saveRound(item, r, { wharf: { ...r.wharf, published: print } }, now);
      log(`${item.key}: review document ${doc} published (${r.state})`);
    } catch (err) {
      log(`${item.key}: review document not published: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Carry out what people asked of this boat's reviews on the hosted glass,
 * then mark each request done (or refused, with why). The one request is
 * Dismiss: the review is sent from the review tool, never from the wharf.
 */
export async function runReviewRequests(log: (m: string) => void = () => {}, opts: ReviewWharfOptions = {}): Promise<void> {
  const dismiss = opts.dismiss ?? ((key: string) => dismissReviewRound(key, 'hosted', { ...(opts.now ? { now: opts.now } : {}) }));
  const scopes = backendScopes(loadConfig()).filter((s) => s.kind === 'wharf');
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = `${scope.location!.url}\n${scope.location!.account}`;
    if (seen.has(key)) continue; // grounds on one wharf account share its requests
    seen.add(key);
    const backend = (opts.backend ?? wharfFor)(scope);
    let requests: WharfHumanRequest[];
    try {
      requests = (await backend.request('requests/reviews')) as WharfHumanRequest[];
    } catch (err) {
      log(`reviews on ${scope.wharf}: requests not read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const req of Array.isArray(requests) ? requests : []) {
      const item = listReviews().find((i) => latestRound(i)?.wharf?.doc === req.document && latestRound(i)?.wharf?.mine);
      const refused = !item ? 'this boat has no such review' : req.kind === 'review-dismiss' ? await dismiss(item.key) : `unknown review request ${req.kind}`;
      try {
        await backend.request(`requests/${req.id}/start`, refused ? { refused: refused.slice(0, 500) } : {}, `${req.id}-${refused ? 'refuse' : 'done'}`);
        log(`${req.document}: ${req.kind} ${refused ? `refused: ${refused}` : 'done'}`);
      } catch (err) {
        log(`${req.document}: ${req.kind} not marked: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
