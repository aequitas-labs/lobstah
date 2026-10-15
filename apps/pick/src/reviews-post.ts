import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  latestRound,
  markReviewPosted,
  readReview,
  readRoundDraft,
  recordGitHubResponse,
  reviewMarker,
  reviewRoundDir,
  writeReview,
} from '@lobstah/core';
import { loadPickupConfig } from './config.js';

const API = 'https://api.github.com';

/**
 * The only review event lobstah ever sends. postReview takes no event
 * argument: no configuration, caller or draft can approve or request
 * changes.
 */
const EVENT = 'COMMENT';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export type PostResult = { posted: true; reviewId: string; by: string } | { posted: false; why: string };

/** Who asked for the post: the glass's Post, the CLI, or `[reviews].post = "auto"`. */
export type PostBy = 'glass' | 'cli' | 'auto';

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
  if (!res.ok) throw new Error(`GitHub ${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/**
 * Post the newest round's draft as a comment-only review, as the
 * configured identity. At most once per round: `posted.json` is created
 * with `wx` before the call and removed if the call fails, and a review on
 * the PR that already carries this round's marker (another boat posted it)
 * is recorded instead of posting again. The review names the head the draft
 * reviewed. A stale draft posts only when `stale` is passed, with a line
 * saying the PR has moved since.
 */
export async function postReview(
  key: string,
  opts: { by: PostBy; stale?: boolean; token?: () => string; fetch?: FetchLike; now?: number },
): Promise<PostResult> {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (!item || !r) return { posted: false, why: `no review item ${key}` };
  if (r.state === 'posted') return { posted: false, why: `${key}: this round is already posted` };
  if (r.state === 'stale' && !opts.stale) return { posted: false, why: `${key}: the draft reviews ${r.headSha.slice(0, 7)} and the PR has moved; re-draft it, or post it anyway as stale` };
  if (r.state !== 'drafted' && r.state !== 'stale') return { posted: false, why: `${key}: the newest round is ${r.state}; there is no draft to post` };
  const draft = readRoundDraft(key, r.id);
  if ('error' in draft) return { posted: false, why: `${key}: ${draft.error}` };
  const token = opts.token ?? loadPickupConfig().github[0]?.token;
  if (!token) return { posted: false, why: 'posting needs [pickup.github] for its identity and token' };

  const receipt = path.join(reviewRoundDir(key, r.id)!, 'posted.json');
  try {
    fs.writeFileSync(receipt, JSON.stringify({ by: opts.by, startedAt: new Date(opts.now ?? Date.now()).toISOString() }), { flag: 'wx' });
  } catch {
    return { posted: false, why: `${key}: a post of this round is already in flight or done` };
  }
  const f = opts.fetch ?? (fetch as FetchLike);
  const { owner, repo, number } = item.pr;
  const marker = reviewMarker(r.id);
  try {
    const existing = await github<Array<{ id: number; body?: string | null }>>(f, token(), 'GET', `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);
    const prior = existing.find((x) => x.body?.includes(marker));
    const at = new Date(opts.now ?? Date.now()).toISOString();
    if (prior) {
      fs.writeFileSync(receipt, JSON.stringify({ reviewId: String(prior.id), by: 'another boat', at }));
      markReviewPosted(key, r.id, { reviewId: String(prior.id), by: 'another boat', at });
      return { posted: true, reviewId: String(prior.id), by: 'another boat' };
    }
    const staleLine = r.state === 'stale' ? `\n\n_Drafted at ${r.headSha.slice(0, 7)}; the PR has moved since._` : '';
    const posted = await github<{ id: number }>(f, token(), 'POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      commit_id: r.headSha,
      event: EVENT,
      body: `${draft.body.trimEnd()}${staleLine}\n\n${marker}`,
      comments: draft.comments.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
    });
    fs.writeFileSync(receipt, JSON.stringify({ reviewId: String(posted.id), by: opts.by, at }));
    markReviewPosted(key, r.id, { reviewId: String(posted.id), by: opts.by, at });
    return { posted: true, reviewId: String(posted.id), by: opts.by };
  } catch (err) {
    fs.rmSync(receipt, { force: true });
    const why = err instanceof Error ? err.message : String(err);
    const fresh = readReview(key);
    const round = fresh?.rounds.find((x) => x.id === r.id);
    if (fresh && round) {
      round.reason = `post failed: ${why}`;
      writeReview({ ...fresh, updatedAt: new Date(opts.now ?? Date.now()).toISOString() });
    }
    return { posted: false, why };
  }
}
