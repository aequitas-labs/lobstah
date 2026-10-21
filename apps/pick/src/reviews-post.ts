import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dismissReview,
  latestRound,
  markReviewPosted,
  readReview,
  readRoundDraft,
  recordGitHubResponse,
  redraftReview,
  reviewMarker,
  reviewRoundDir,
  writeReview,
} from '@lobstah/core';
import type { ReviewComment, ReviewRound } from '@lobstah/core';
import { loadPickupConfig } from './config.js';

const API = 'https://api.github.com';

/**
 * The only review event lobstah ever sends itself. Neither postReview nor
 * stageReview takes an event argument: no configuration, caller or draft
 * can approve or request changes. A staged review is sent by the person,
 * from their own review tool, with whatever event they choose there.
 */
const EVENT = 'COMMENT';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export type PostResult = { posted: true; reviewId: string; by: string } | { posted: false; why: string };

/** Who asked for the post: the CLI, or `[reviews].post = "auto"`. */
export type PostBy = 'cli' | 'auto';

type Opts = { token?: () => string; fetch?: FetchLike; now?: number };

class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function github<T>(f: FetchLike, token: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await f(`${API}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'lobstah-pick',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  recordGitHubResponse(headers, { success: res.ok });
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function context(key: string, opts: Opts): { r: ReviewRound; token: () => string; f: FetchLike; at: string; base: string } | string {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (!item || !r) return `no review item ${key}`;
  const config = opts.token ? undefined : loadPickupConfig();
  const token = opts.token ?? config?.reviews?.token ?? config?.githubIdentity?.token;
  if (!token) return 'reviews need an identity and token source';
  return { r, token, f: opts.fetch ?? (fetch as FetchLike), at: new Date(opts.now ?? Date.now()).toISOString(), base: `/repos/${item.pr.owner}/${item.pr.repo}/pulls/${item.pr.number}/reviews` };
}

function saveRound(key: string, roundId: string, change: (r: ReviewRound) => void, at: string): void {
  const fresh = readReview(key);
  const round = fresh?.rounds.find((x) => x.id === roundId);
  if (!fresh || !round) return;
  change(round);
  writeReview({ ...fresh, updatedAt: at });
}

/** A once-only receipt in the round's directory: created with `wx` before a write to GitHub, removed if it fails. */
function receipt(key: string, roundId: string, name: string, by: string, at: string): string | undefined {
  const file = path.join(reviewRoundDir(key, roundId)!, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ by, startedAt: at }), { flag: 'wx' });
    return file;
  } catch {
    return undefined;
  }
}

/** The draft's inline comments, each ending with the round's marker: lobstah wrote them, so feedback pickup never reads them as the owner's. */
function inlineComments(comments: ReviewComment[], r: ReviewRound) {
  return comments.map((x) => ({ path: x.path, line: x.line, side: x.side ?? 'RIGHT', body: `${x.body.trimEnd()}\n\n${reviewMarker(r.id)}` }));
}

function reviewBody(body: string, r: ReviewRound): string {
  const staleLine = r.state === 'stale' ? `\n\n_Drafted at ${r.headSha.slice(0, 7)}; the PR has moved since._` : '';
  return `${body.trimEnd()}${staleLine}\n\n${reviewMarker(r.id)}`;
}

/**
 * Stage the newest round's draft on the PR as a pending review: GitHub
 * shows it only to the configured identity, who opens the PR in their
 * review tool, edits it, and sends it from there. Nothing is posted. Once
 * per round: `staged.json` guards the write, and a pending review that
 * already carries the round's marker is adopted instead of staged again.
 */
export async function stageReview(key: string, opts: Opts = {}): Promise<{ staged: true; reviewId: string } | { staged: false; why: string }> {
  const c = context(key, opts);
  if (typeof c === 'string') return { staged: false, why: c };
  const { r, token, f, at, base } = c;
  if (r.staged) return { staged: false, why: `${key}: this round is already staged` };
  if (r.state !== 'drafted') return { staged: false, why: `${key}: the newest round is ${r.state}; only a fresh draft is staged` };
  const draft = readRoundDraft(key, r.id);
  if ('error' in draft) return { staged: false, why: `${key}: ${draft.error}` };
  const lock = receipt(key, r.id, 'staged.json', 'stage', at);
  if (!lock) return { staged: false, why: `${key}: staging this round is already in flight or done` };
  try {
    const existing = await github<Array<{ id: number; state: string; body?: string | null }>>(f, token(), 'GET', `${base}?per_page=100`);
    const prior = existing.find((x) => x.body?.includes(reviewMarker(r.id)));
    if (prior && prior.state !== 'PENDING') {
      markReviewPosted(key, r.id, { reviewId: String(prior.id), by: 'review tool', at });
      return { staged: false, why: `${key}: already sent (review ${prior.id})` };
    }
    const id = prior
      ? prior.id
      : (
          await github<{ id: number }>(f, token(), 'POST', base, {
            commit_id: r.headSha,
            body: reviewBody(draft.body, r),
            comments: inlineComments(draft.comments, r),
          })
        ).id;
    fs.writeFileSync(lock, JSON.stringify({ reviewId: String(id), at }));
    saveRound(
      key,
      r.id,
      (x) => {
        x.staged = { reviewId: String(id), at };
        delete x.reason;
      },
      at,
    );
    return { staged: true, reviewId: String(id) };
  } catch (err) {
    fs.rmSync(lock, { force: true });
    const why = err instanceof Error ? err.message : String(err);
    saveRound(key, r.id, (x) => (x.reason = `stage failed: ${why}`), at);
    return { staged: false, why };
  }
}

/**
 * Post the newest round as a comment-only review, as the configured
 * identity: submit its staged pending review, or create the review when it
 * was never staged (`[reviews].post = "auto"`). At most once per round:
 * `posted.json` guards the write, and a sent review that already carries
 * the round's marker (another boat posted it) is recorded instead. A stale
 * draft is always refused; re-draft against the current head before publishing.
 */
export async function postReview(key: string, opts: Opts & { by: PostBy; stale?: boolean }): Promise<PostResult> {
  const c = context(key, opts);
  if (typeof c === 'string') return { posted: false, why: c };
  const { r, token, f, at, base } = c;
  if (r.state === 'posted') return { posted: false, why: `${key}: this round is already posted` };
  if (r.state === 'stale' || r.headSha !== readReview(key)?.pr.headSha) return { posted: false, why: `${key}: the draft is stale; re-draft it before publishing` };
  if (r.state !== 'drafted') return { posted: false, why: `${key}: the newest round is ${r.state}; there is no draft to post` };
  const draft = readRoundDraft(key, r.id);
  if ('error' in draft) return { posted: false, why: `${key}: ${draft.error}` };
  const lock = receipt(key, r.id, 'posted.json', opts.by, at);
  if (!lock) return { posted: false, why: `${key}: a post of this round is already in flight or done` };
  try {
    const existing = await github<Array<{ id: number; state?: string; body?: string | null }>>(f, token(), 'GET', `${base}?per_page=100`);
    const prior = existing.find((x) => x.body?.includes(reviewMarker(r.id)) && x.state !== 'PENDING');
    if (prior) {
      fs.writeFileSync(lock, JSON.stringify({ reviewId: String(prior.id), by: 'another boat', at }));
      markReviewPosted(key, r.id, { reviewId: String(prior.id), by: 'another boat', at });
      return { posted: true, reviewId: String(prior.id), by: 'another boat' };
    }
    // A push can land between the search and this write. Verify the head
    // immediately before publishing, including a staged pending review.
    const current = await github<{ head?: { sha?: string }; state?: string }>(f, token(), 'GET', base.replace(/\/reviews$/, ''));
    if (current.head?.sha !== r.headSha || (current.state !== undefined && current.state !== 'open')) {
      fs.rmSync(lock, { force: true });
      saveRound(key, r.id, (x) => { x.state = 'stale'; x.reason = 'the PR head changed or closed before publishing; re-draft it'; }, at);
      return { posted: false, why: `${key}: the PR head changed or closed before publishing; re-draft it` };
    }
    const posted = r.staged
      ? await github<{ id: number }>(f, token(), 'POST', `${base}/${r.staged.reviewId}/events`, { event: EVENT, body: reviewBody(draft.body, r) })
      : await github<{ id: number }>(f, token(), 'POST', base, {
          commit_id: r.headSha,
          event: EVENT,
          body: reviewBody(draft.body, r),
          comments: inlineComments(draft.comments, r),
        });
    fs.writeFileSync(lock, JSON.stringify({ reviewId: String(posted.id), by: opts.by, at }));
    markReviewPosted(key, r.id, { reviewId: String(posted.id), by: opts.by, at });
    return { posted: true, reviewId: String(posted.id), by: opts.by };
  } catch (err) {
    fs.rmSync(lock, { force: true });
    const why = err instanceof Error ? err.message : String(err);
    saveRound(key, r.id, (x) => (x.reason = `post failed: ${why}`), at);
    return { posted: false, why };
  }
}

/**
 * The request is gone and the round was staged: did the person send the
 * review from their tool? A submitted review marks the round posted (by
 * `review tool`); a review deleted there dismisses it; a still-pending one
 * is left alone, for the caller to withdraw the round.
 */
export async function settleStagedReview(key: string, opts: Opts = {}): Promise<'posted' | 'pending' | 'deleted' | 'unknown'> {
  const c = context(key, opts);
  if (typeof c === 'string' || !c.r.staged) return 'unknown';
  const { r, token, f, at, base } = c;
  try {
    const review = await github<{ id: number; state: string }>(f, token(), 'GET', `${base}/${r.staged!.reviewId}`);
    if (review.state === 'PENDING') return 'pending';
    markReviewPosted(key, r.id, { reviewId: String(review.id), by: 'review tool', at });
    return 'posted';
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      dismissReview(key, 'review tool', opts.now);
      return 'deleted';
    }
    return 'unknown';
  }
}

/** Delete the round's staged pending review, if it is still pending. Nothing a person sent is ever deleted. */
async function discardStaged(key: string, opts: Opts): Promise<string | undefined> {
  const item = readReview(key);
  if (!(item && latestRound(item))?.staged) return undefined;
  const c = context(key, opts);
  if (typeof c === 'string') return c;
  const { r, token, f, at, base } = c;
  if (!r.staged) return undefined;
  try {
    const review = await github<{ state: string }>(f, token(), 'GET', `${base}/${r.staged.reviewId}`);
    if (review.state !== 'PENDING') {
      markReviewPosted(key, r.id, { reviewId: r.staged.reviewId, by: 'review tool', at });
      return `${key}: this review was already sent from the review tool`;
    }
    await github(f, token(), 'DELETE', `${base}/${r.staged.reviewId}`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) return err instanceof Error ? err.message : String(err);
  }
  fs.rmSync(path.join(reviewRoundDir(key, r.id)!, 'staged.json'), { force: true });
  saveRound(key, r.id, (x) => delete x.staged, at);
  return undefined;
}

/** Dismiss the newest round: its pending review is deleted from the PR, and nothing is posted. */
export async function dismissReviewRound(key: string, by: string, opts: Opts = {}): Promise<string | undefined> {
  const why = await discardStaged(key, opts);
  if (why) return why;
  const out = dismissReview(key, by, opts.now);
  return typeof out === 'string' ? out : undefined;
}

/** Re-draft a stale or failed round: its pending review is deleted first, so the new draft can be staged. */
export async function redraftReviewRound(key: string, opts: Opts = {}): Promise<string | undefined> {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (r && r.state !== 'stale' && r.state !== 'failed') return `${key}: the newest round is ${r.state}; only a stale or failed round re-drafts`;
  const why = await discardStaged(key, opts);
  if (why) return why;
  const out = redraftReview(key, opts.now);
  return typeof out === 'string' ? out : undefined;
}
