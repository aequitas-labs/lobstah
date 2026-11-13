import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dismissReview,
  dispatchWasCancelled,
  loadConfig,
  reviewCanPublish,
  latestRound,
  markReviewPosted,
  readReview,
  readRoundDraft,
  recordGitHubResponse,
  redraftReview,
  reviewMarker,
  reviewRoundDir,
  writeReview,
  acknowledgeReview,
} from '@lobstah/core';
import type { ReviewComment, ReviewRound } from '@lobstah/core';
import { loadPickupConfig } from './config.js';

const API = 'https://api.github.com';

/**
 * Automated reviews may post only an explicitly enabled approve or request-changes verdict.
 */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export type PostResult = { posted: true; reviewId: string; by: string } | { posted: false; why: string };

/** Who asked for the post: the CLI, a glass button, or automatic publishing. */
export type PostBy = 'cli' | 'auto' | 'glass';

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

function draftComments(draft: { comments: ReviewComment[]; blocking: ReviewComment[] }): ReviewComment[] {
  return [...draft.comments, ...draft.blocking.filter(b => !draft.comments.some(c => c.path === b.path && c.line === b.line && c.body === b.body))];
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
  const refused = postRefusal(key, r, 'cli');
  if (refused) return { staged: false, why: refused };
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
    const refused = postRefusal(key, r, 'cli');
    if (refused) { fs.rmSync(lock, { force: true }); return { staged: false, why: refused }; }
    const id = prior
      ? prior.id
      : (
          await github<{ id: number }>(f, token(), 'POST', base, {
            commit_id: r.headSha,
            body: reviewBody(draft.body, r),
            comments: inlineComments(draftComments(draft), r),
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

/** Re-read local policy and cancellation after awaits, immediately before a GitHub write. */
function postRefusal(key: string, round: ReviewRound, by: PostBy): string | undefined {
  const item = readReview(key);
  const current = item && latestRound(item);
  if (!item || !current || current.id !== round.id || current.state !== 'drafted' || current.headSha !== item.pr.headSha)
    return `${key}: this round is no longer ready to publish`;
  if (by === 'auto' && item.mutedAt) return `${key}: automatic posting is disabled while this PR is muted`;
  if (current.dispatch && dispatchWasCancelled(current.dispatch, 'chore')) return `${key}: the review job was cancelled`;
  if (by === 'auto' && !reviewCanPublish(loadConfig().reviews, item.pr.repoKey, current)) return `${key}: automatic publishing is off for this round`;
  return undefined;
}

/**
 * Post the newest round with its selected verdict, as the configured
 * identity: submit its staged pending review, or create the review when it
 * was never staged (`[reviews].post = "auto"`). At most once per round:
 * `posted.json` guards the write, and a sent review that already carries
 * the round's marker (another boat posted it) is recorded instead. A stale
 * draft is always refused; re-draft against the current head before publishing.
 */
export async function postReview(key: string, opts: Opts & { by: PostBy; stale?: boolean; event?: ReviewEvent }): Promise<PostResult> {
  const c = context(key, opts);
  if (typeof c === 'string') return { posted: false, why: c };
  const { r, token, f, at, base } = c;
  if (r.state === 'posted') return { posted: false, why: `${key}: this round is already posted` };
  if (r.state === 'stale' || r.headSha !== readReview(key)?.pr.headSha) return { posted: false, why: `${key}: the draft is stale; re-draft it before publishing` };
  if (r.state !== 'drafted') return { posted: false, why: `${key}: the newest round is ${r.state}; there is no draft to post` };
  const refused = postRefusal(key, r, opts.by);
  if (refused) return { posted: false, why: refused };
  const draft = readRoundDraft(key, r.id);
  if ('error' in draft) return { posted: false, why: `${key}: ${draft.error}` };
  const event = opts.event ?? (opts.by === 'auto' && draft.verdict === 'approve' ? 'APPROVE' : draft.blocking.length ? 'REQUEST_CHANGES' : 'COMMENT');
  if (!['COMMENT', 'REQUEST_CHANGES', 'APPROVE'].includes(event)) return { posted: false, why: 'invalid review event' };
  const expected = draft.verdict === 'approve' ? 'APPROVE' : draft.blocking.length ? 'REQUEST_CHANGES' : 'COMMENT';
  if (opts.by === 'glass' && event !== expected) return { posted: false, why: 'the action does not match the draft verdict' };
  if (opts.by === 'auto' && !['APPROVE', 'REQUEST_CHANGES'].includes(event)) return { posted: false, why: 'automatic posting is only available for approve and request-changes verdicts' };
  if (opts.by === 'auto' && event !== expected) return { posted: false, why: 'automatic posting must follow the draft verdict' };
  if (event === 'APPROVE' && (!['glass', 'auto'].includes(opts.by) || draft.verdict !== 'approve' || draft.blocking.length)) return { posted: false, why: 'approval requires an approve verdict with no blocking findings' };
  if (event === 'REQUEST_CHANGES' && !draft.blocking.length) return { posted: false, why: 'request changes requires blocking findings' };
  if (opts.by === 'auto') {
    const identity = loadConfig().reviews.identity?.toLowerCase();
    if (!identity) return { posted: false, why: 'automatic posting needs a configured reviewer identity' };
    try {
      const author = await github<{ login?: string }>(f, token(), 'GET', '/user');
      if (author.login?.toLowerCase() !== identity) return { posted: false, why: `automatic posting is disabled because the GitHub token belongs to ${author.login ?? 'an unknown identity'}, not ${identity}` };
    } catch (err) {
      return { posted: false, why: `automatic posting could not confirm the configured reviewer identity: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
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
    const refused = postRefusal(key, r, opts.by);
    if (refused) {
      fs.rmSync(lock, { force: true });
      return { posted: false, why: refused };
    }
    const posted = r.staged
      ? await github<{ id: number }>(f, token(), 'POST', `${base}/${r.staged.reviewId}/events`, { event, body: reviewBody(draft.body, r) })
      : await github<{ id: number }>(f, token(), 'POST', base, {
          commit_id: r.headSha,
          event,
          body: reviewBody(draft.body, r),
          comments: inlineComments(draftComments(draft), r),
        });
    fs.writeFileSync(lock, JSON.stringify({ reviewId: String(posted.id), by: opts.by, at }));
    markReviewPosted(key, r.id, { reviewId: String(posted.id), by: opts.by, at });
    if (opts.by !== 'auto') acknowledgeReview(key, opts.now);
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
  if (typeof out !== 'string') acknowledgeReview(key, opts.now);
  return typeof out === 'string' ? out : undefined;
}

/** Re-draft a stale or failed round: its pending review is deleted first, so the new draft can be staged. */
export async function redraftReviewRound(key: string, opts: Opts = {}): Promise<string | undefined> {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (r && !['drafted', 'stale', 'failed'].includes(r.state)) return `${key}: the newest round is ${r.state}; only a drafted, stale or failed round re-drafts`;
  const why = await discardStaged(key, opts);
  if (why) return why;
  const out = redraftReview(key, opts.now);
  return typeof out === 'string' ? out : undefined;
}
