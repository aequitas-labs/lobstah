import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dismissReview,
  dispatchWasCancelled,
  loadConfig,
  reviewCanPublish,
  reviewDraftCoversHead,
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
  reviewDecisionBody,
  reviewThreadReplies,
  unansweredReviewDecisions,
} from '@lobstah/core';
import type { ReviewComment, ReviewDecision, ReviewRound, ReviewMemory, ReviewThreadCall } from '@lobstah/core';
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
  return comments.map((x) => ({ path: x.path, line: x.line, side: x.side ?? 'RIGHT', body: `${publishableBody(x.body)}\n\n${reviewMarker(r.id)}` }));
}

/** Remove draft receipts from text that will be visible in a submitted review. */
function publishableBody(body: string): string {
  return body.replace(/(?:\*\*|__|\*)?draft only\s*[;:.—–-]\s*nothing (?:was|has been) posted(?: to github)?\.?(?:\*\*|__|\*)?/gi, '').trim();
}

/** Match explicit finding identities or a substantially repeated explanation at one anchor. */
function sameFinding(left: ReviewComment, right: ReviewComment): boolean {
  if (left.path !== right.path || left.line !== right.line || (left.side ?? 'RIGHT') !== (right.side ?? 'RIGHT')) return false;
  if (left.findingId && right.findingId) return left.findingId === right.findingId;
  const normalize = (body: string): string => publishableBody(body).toLowerCase()
    .replace(/\[(?:p[0-3]|blocking)\]|\bblocking\s*:/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = normalize(left.body), b = normalize(right.body);
  if (a === b) return true;
  // A shared descriptive title is stronger evidence than a shared line.
  // Distinct titles stay separate even if the explanations use similar terms.
  const title = (body: string): string | undefined => /^\s*(?:\*\*|#+\s+)([^\n]+?)(?:\*\*|\n|$)/.exec(body)?.[1];
  const leftTitle = title(left.body), rightTitle = title(right.body);
  if (leftTitle && rightTitle) {
    const description = normalize(leftTitle);
    return description.length >= 24 && description.split(' ').length >= 4 && description === normalize(rightTitle);
  }
  if (Math.min(a.length, b.length) >= 40 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

/** Keep one marked blocker for a duplicated finding; unrelated points at the same line survive. */
function draftComments(draft: { comments: ReviewComment[]; blocking: ReviewComment[] }): ReviewComment[] {
  return [
    ...draft.comments.filter(comment => !draft.blocking.some(blocker => sameFinding(comment, blocker))),
    ...draft.blocking.filter((blocker, index) => !draft.blocking.slice(0, index).some(previous => sameFinding(previous, blocker)))
      .map(blocker => ({ ...blocker, body: `**Blocking:** ${publishableBody(blocker.body)}` })),
  ];
}

function reviewBody(body: string, r: ReviewRound, decisions: ReviewDecision[], threads?: readonly ReviewThreadCall[]): string {
  const staleLine = r.state === 'stale' ? `\n\n_Drafted at ${r.headSha.slice(0, 7)}; the PR has moved since._` : '';
  const replies = reviewThreadReplies(r, threads, loadConfig().reviews.identity);
  return `${[publishableBody(body), reviewDecisionBody(decisions, r.decisionAnswers), replies].filter(Boolean).join('\n\n')}${staleLine}\n\n${reviewMarker(r.id)}`;
}

/** Known generated text is replaceable; anything edited or added by a person stays. */
function generatedDraftContent(key: string): { bodies: string[]; comments: Set<string> } {
  const item = readReview(key)!;
  const bodies: string[] = [];
  const comments = new Set<string>();
  for (const round of item.rounds) {
    for (const receipt of [round.staged, round.pendingReview]) {
      if (receipt?.generatedBody) bodies.push(receipt.generatedBody);
      for (const body of receipt?.generatedComments ?? []) comments.add(body.trim());
    }
    const current = readRoundDraft(key, round.id);
    const drafts: Array<Pick<ReviewMemory, 'body' | 'comments' | 'blocking' | 'decisions' | 'decisionAnswers'> & { threads?: ReviewThreadCall[] }> = [
      ...(round.previousReviews ?? []), ...('error' in current ? [] : [current]),
    ];
    for (const draft of drafts) {
      bodies.push(reviewBody(draft.body, { ...round, state: 'drafted', decisionAnswers: draft.decisionAnswers }, draft.decisions ?? [], draft.threads));
      bodies.push(draftComments(draft).map(comment => `${comment.path}:${comment.line}\n\n${publishableBody(comment.body)}`).join('\n\n'));
      for (const comment of inlineComments(draftComments(draft), round)) comments.add(comment.body.trim());
    }
  }
  return { bodies: [...new Set(bodies.filter(Boolean))].sort((left, right) => right.length - left.length), comments };
}

/** Strip only exact generated passages, keeping unsent summaries and edits intact. */
function replaceGeneratedDraft(body: string, generated: readonly string[], replacement: string): string {
  let retained = body;
  for (const passage of generated) retained = retained.split(passage).join('');
  retained = retained.replace(/^(?:\s*---\s*)+|(?:\s*---\s*)+$/g, '').trim();
  return [retained, replacement].filter(Boolean).join('\n\n---\n\n');
}

interface PendingComment { id: number; body: string; path: string; line?: number | null; original_line?: number | null }

/** Read every pending comment before replacing a review; private comments never leave this draft. */
async function pendingComments(reviewId: number, gh: { f: FetchLike; token: () => string; base: string }): Promise<PendingComment[]> {
  const comments: PendingComment[] = [];
  for (let page = 1; ; page++) {
    const batch = await github<PendingComment[]>(gh.f, gh.token(), 'GET', `${gh.base}/${reviewId}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

/** Remove unchanged lobstah inline findings, never human comments or edited findings. */
async function clearGeneratedComments(key: string, round: ReviewRound, reviewId: number, known: ReadonlySet<string>,
  gh: { f: FetchLike; token: () => string; base: string }): Promise<void> {
  const endpoint = gh.base.replace(/\/pulls\/\d+\/reviews$/, '/pulls/comments');
  for (const comment of await pendingComments(reviewId, gh)) {
    if (!comment.path || !known.has(comment.body?.trim())) continue;
    const pending = await github<{ state: string }>(gh.f, gh.token(), 'GET', `${gh.base}/${reviewId}`);
    if (pending.state !== 'PENDING') throw new Error('This review was already sent from the review tool.');
    const current = await github<{ body: string }>(gh.f, gh.token(), 'GET', `${endpoint}/${comment.id}`);
    if (current.body?.trim() !== comment.body.trim()) continue;
    const refused = postRefusal(key, round, 'cli');
    if (refused) throw new Error(refused);
    await github(gh.f, gh.token(), 'DELETE', `${endpoint}/${comment.id}`);
  }
}

/**
 * Stage the newest round's draft on the PR as a pending review: GitHub
 * shows it only to the configured identity, who opens the PR in their
 * review tool, edits it, and sends it from there. Nothing is posted. Once
 * per round: `staged.json` guards the write, and a pending review that
 * already carries the round's marker is adopted and updated instead of duplicated.
 * Existing body text and inline comments survive re-requests and redrafts.
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
    const existing = await github<Array<{ id: number; state: string; body?: string | null; user?: { login: string } }>>(f, token(), 'GET', `${base}?per_page=100`);
    const prior = existing.find((x) => String(x.id) === r.pendingReview?.reviewId) ?? existing.find((x) => x.body?.includes(reviewMarker(r.id)));
    if (prior && prior.state !== 'PENDING') {
      markReviewPosted(key, r.id, { reviewId: String(prior.id), by: 'review tool', at });
      return { staged: false, why: `${key}: already sent (review ${prior.id})` };
    }
    const refused = postRefusal(key, r, 'cli');
    if (refused) { fs.rmSync(lock, { force: true }); return { staged: false, why: refused }; }
    // GitHub allows one pending review per identity, across all request rounds.
    // Keep its body and inline comments intact; put the new draft alongside them.
    const identity = loadConfig().reviews.identity?.toLowerCase();
    const pending = prior ?? (identity
      ? existing.find(review => review.state === 'PENDING' && review.user?.login.toLowerCase() === identity)
      : undefined);
    let generatedBody = reviewBody(draft.body, r, draft.decisions, draft.threads);
    let created = false;
    let id: number;
    const createPending = async (preservedBody = ''): Promise<number> => {
      const refused = postRefusal(key, r, 'cli');
      if (refused) throw new Error(refused);
      created = true;
      return (await github<{ id: number }>(f, token(), 'POST', base, {
        commit_id: readReview(key)!.pr.headSha,
        body: [preservedBody, generatedBody].filter(Boolean).join('\n\n---\n\n'),
        comments: inlineComments(draftComments(draft), r),
      })).id;
    };
    if (pending) {
      const live = await github<{ state: string; body?: string | null; commit_id?: string }>(f, token(), 'GET', `${base}/${pending.id}`);
      if (live.state !== 'PENDING') {
        markReviewPosted(key, r.id, { reviewId: String(pending.id), by: 'review tool', at });
        return { staged: false, why: `${key}: already sent (review ${pending.id})` };
      }
      const generated = generatedDraftContent(key);
      if (live.commit_id && live.commit_id !== readReview(key)!.pr.headSha) {
        const comments = await pendingComments(pending.id, { f, token, base });
        const handwritten = comments.filter(comment => comment.path && !generated.comments.has(comment.body.trim()));
        const preservedBody = [replaceGeneratedDraft(live.body ?? '', generated.bodies, ''),
          ...handwritten.map(comment => `${comment.path}:${comment.line ?? comment.original_line ?? '?'}\n\n${comment.body}`),
        ].filter(Boolean).join('\n\n---\n\n');
        // Save human work before deleting the old commit-bound review. A failed
        // replacement reuses this backup on the next staging attempt.
        saveRound(key, r.id, round => { round.pendingReview = { reviewId: String(pending.id), at, preservedBody }; }, at);
        const confirmed = await github<{ state: string; body?: string | null }>(f, token(), 'GET', `${base}/${pending.id}`);
        const currentComments = await pendingComments(pending.id, { f, token, base });
        if (confirmed.state !== 'PENDING' || confirmed.body !== live.body || JSON.stringify(currentComments) !== JSON.stringify(comments))
          throw new Error('The pending review changed during refresh. It will be checked again.');
        const refused = postRefusal(key, r, 'cli');
        if (refused) throw new Error(refused);
        await github(f, token(), 'DELETE', `${base}/${pending.id}`);
        id = await createPending(preservedBody);
      } else {
        const findings = draftComments(draft).map(comment => `${comment.path}:${comment.line}\n\n${publishableBody(comment.body)}`).join('\n\n');
        generatedBody = [generatedBody, findings].filter(Boolean).join('\n\n');
        const body = replaceGeneratedDraft(live.body ?? '', generated.bodies, generatedBody);
        const refused = postRefusal(key, r, 'cli');
        if (refused) throw new Error(refused);
        if (body !== live.body) await github(f, token(), 'PUT', `${base}/${pending.id}`, { body });
        await clearGeneratedComments(key, r, pending.id, generated.comments, { f, token, base });
        id = pending.id;
      }
    } else id = await createPending(r.pendingReview?.preservedBody);
    fs.writeFileSync(lock, JSON.stringify({ reviewId: String(id), at }));
    saveRound(
      key,
      r.id,
      (x) => {
        x.staged = { reviewId: String(id), at, generatedBody, generatedComments: !created ? [] : inlineComments(draftComments(draft), r).map(comment => comment.body) };
        delete x.pendingReview;
        delete x.refresh;
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
  if (!item || !current || current.id !== round.id || current.state !== 'drafted')
    return `${key}: this round is no longer ready to publish`;
  const draft = readRoundDraft(key, current.id);
  if ('error' in draft) return `${key}: ${draft.error}`;
  if (!reviewDraftCoversHead(item, current, draft)) return `${key}: this round is no longer ready to publish`;
  if (unansweredReviewDecisions({ ...current, decisions: draft.decisions }).length) return 'Answer every decision before posting this review.';
  if (by === 'auto' && item.mutedAt) return `${key}: automatic posting is disabled while this PR is muted`;
  if (current.dispatch && dispatchWasCancelled(current.dispatch, 'chore')) return `${key}: the review job was cancelled`;
  if (by === 'auto' && !reviewCanPublish(loadConfig().reviews, item.pr.repoKey, current)) return `${key}: automatic publishing is off for this round`;
  return undefined;
}

/** A person's explicit override discards the pending draft and approves the live PR head. */
async function approveWithoutDraft(key: string, opts: Opts & { by: PostBy }): Promise<PostResult> {
  if (opts.by !== 'glass') return { posted: false, why: 'Approve anyway requires your click in the glass' };
  const c = context(key, opts);
  if (typeof c === 'string') return { posted: false, why: c };
  const { r, token, f, at, base } = c;
  const item = readReview(key)!;
  if (['CLOSED', 'MERGED'].includes(item.pr.state ?? '')) return { posted: false, why: 'This PR is closed or merged.' };
  const lock = receipt(key, r.id, 'approved.json', 'glass', at);
  if (!lock) return { posted: false, why: 'An approval of this round is already in flight or done.' };
  const marker = reviewMarker(`${r.id}-approve`);
  const finish = (reviewId: string, head: string): PostResult => {
    const fresh = readReview(key)!;
    const round = fresh.rounds.find(round => round.id === r.id)!;
    if (fresh.pr.headSha !== head) { delete fresh.pr.diffId; delete fresh.pr.baseSha; }
    fresh.pr.headSha = head;
    Object.assign(round, { headSha: head, verdict: 'approve', blocking: [] });
    round.diffId = fresh.pr.diffId;
    round.baseSha = fresh.pr.baseSha;
    writeReview(fresh);
    fs.writeFileSync(lock, JSON.stringify({ reviewId, by: 'glass', at }));
    markReviewPosted(key, r.id, { reviewId, by: 'glass', at, verdict: 'approve', event: 'APPROVE' });
    return { posted: true, reviewId, by: 'glass' };
  };
  try {
    const existing = await github<Array<{ id: number; state: string; body?: string; commit_id?: string }>>(f, token(), 'GET', `${base}?per_page=100`);
    const approved = existing.find(review => review.state === 'APPROVED' && review.body?.includes(marker));
    if (approved) return finish(String(approved.id), approved.commit_id ?? r.headSha);
    let current = await github<{ state: string; head: { sha: string } }>(f, token(), 'GET', base.replace(/\/reviews$/, ''));
    if (current.state !== 'open' || !current.head?.sha) throw new Error('This PR is closed or merged.');
    const pendingIds = new Set([
      ...(r.staged ? [r.staged.reviewId] : []),
      ...(r.pendingReview ? [r.pendingReview.reviewId] : []),
      ...existing.filter(review => review.state === 'PENDING' && review.body?.includes(reviewMarker(r.id))).map(review => String(review.id)),
    ]);
    for (const reviewId of pendingIds) {
      try {
        const pending = await github<{ state: string }>(f, token(), 'GET', `${base}/${reviewId}`);
        if (pending.state === 'PENDING') await github(f, token(), 'DELETE', `${base}/${reviewId}`);
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
      }
    }
    if (pendingIds.size) {
      current = await github<{ state: string; head: { sha: string } }>(f, token(), 'GET', base.replace(/\/reviews$/, ''));
      if (current.state !== 'open' || !current.head?.sha) throw new Error('This PR is closed or merged.');
    }
    if (latestRound(readReview(key)!)?.id !== r.id) throw new Error('A new review round opened. Approve it from the updated row.');
    const posted = await github<{ id: number }>(f, token(), 'POST', base, { commit_id: current.head.sha, event: 'APPROVE', body: marker });
    return finish(String(posted.id), current.head.sha);
  } catch (error) {
    fs.rmSync(lock, { force: true });
    return { posted: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Post the newest round with its selected verdict, as the configured
 * identity: submit its staged pending review, or create the review when it
 * was never staged (`[reviews].post = "auto"`). At most once per round:
 * `posted.json` guards the write, and a sent review that already carries
 * the round's marker (another boat posted it) is recorded instead. A stale
 * draft is always refused; re-draft against the current head before publishing.
 */
export async function postReview(key: string, opts: Opts & { by: PostBy; stale?: boolean; event?: ReviewEvent; approveAnyway?: boolean }): Promise<PostResult> {
  if (opts.approveAnyway) return approveWithoutDraft(key, opts);
  const c = context(key, opts);
  if (typeof c === 'string') return { posted: false, why: c };
  const { r, token, f, at, base } = c;
  if (r.state === 'posted') return { posted: false, why: `${key}: this round is already posted` };
  if (r.state === 'stale') return { posted: false, why: `${key}: the draft is stale; re-draft it before publishing` };
  if (r.state !== 'drafted') return { posted: false, why: `${key}: the newest round is ${r.state}; there is no draft to post` };
  const refused = postRefusal(key, r, opts.by);
  if (refused) return { posted: false, why: refused };
  const draft = readRoundDraft(key, r.id);
  if ('error' in draft) return { posted: false, why: `${key}: ${draft.error}` };
  const item = readReview(key)!;
  if (!reviewDraftCoversHead(item, r, draft)) return { posted: false, why: `${key}: the draft is stale; re-draft it before publishing` };
  const targetHead = item.pr.headSha;
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
    if (current.head?.sha !== targetHead || (current.state !== undefined && current.state !== 'open')) {
      fs.rmSync(lock, { force: true });
      saveRound(key, r.id, (x) => { x.state = 'stale'; x.reason = 'the PR head changed or closed before publishing; re-draft it'; }, at);
      return { posted: false, why: `${key}: the PR head changed or closed before publishing; re-draft it` };
    }
    const refused = postRefusal(key, r, opts.by);
    if (refused) {
      fs.rmSync(lock, { force: true });
      return { posted: false, why: refused };
    }
    const pendingBody = r.staged && existing.find(review => String(review.id) === r.staged!.reviewId)?.body;
    const decisions = reviewDecisionBody(draft.decisions, latestRound(readReview(key)!)!.decisionAnswers);
    const body = typeof pendingBody === 'string'
      ? [pendingBody, ...(decisions && !pendingBody.includes(decisions) ? [decisions] : [])].join('\n\n')
      : reviewBody(draft.body, latestRound(readReview(key)!)!, draft.decisions, draft.threads);
    const posted = r.staged
      ? await github<{ id: number }>(f, token(), 'POST', `${base}/${r.staged.reviewId}/events`, { event, body })
      : await github<{ id: number }>(f, token(), 'POST', base, {
          commit_id: targetHead,
          event,
          body: reviewBody(draft.body, latestRound(readReview(key)!)!, draft.decisions, draft.threads),
          comments: inlineComments(draftComments(draft), r),
        });
    fs.writeFileSync(lock, JSON.stringify({ reviewId: String(posted.id), by: opts.by, at }));
    markReviewPosted(key, r.id, { reviewId: String(posted.id), by: opts.by, at, event });
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
 * stays in the inbox until it is submitted or dismissed.
 */
export async function settleStagedReview(key: string, opts: Opts = {}): Promise<'posted' | 'pending' | 'deleted' | 'unknown'> {
  const c = context(key, opts);
  if (typeof c === 'string' || !c.r.staged) return 'unknown';
  const { r, token, f, at, base } = c;
  try {
    const review = await github<{ id: number; state: string }>(f, token(), 'GET', `${base}/${r.staged!.reviewId}`);
    if (review.state === 'PENDING') return 'pending';
    if (review.state === 'DISMISSED') { dismissReview(key, 'review tool', opts.now); return 'deleted'; }
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
  const newest = item && latestRound(item);
  if (!(newest?.staged ?? newest?.pendingReview)) return undefined;
  const c = context(key, opts);
  if (typeof c === 'string') return c;
  const { r, token, f, at, base } = c;
  const pending = r.staged ?? r.pendingReview;
  if (!pending) return undefined;
  try {
    const review = await github<{ state: string }>(f, token(), 'GET', `${base}/${pending.reviewId}`);
    if (review.state !== 'PENDING') {
      markReviewPosted(key, r.id, { reviewId: pending.reviewId, by: 'review tool', at });
      return `${key}: this review was already sent from the review tool`;
    }
    await github(f, token(), 'DELETE', `${base}/${pending.reviewId}`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) return err instanceof Error ? err.message : String(err);
  }
  fs.rmSync(path.join(reviewRoundDir(key, r.id)!, 'staged.json'), { force: true });
  saveRound(key, r.id, (x) => { delete x.staged; delete x.pendingReview; delete x.refresh; }, at);
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

/** Re-draft locally, retaining the pending review and any edits for the next staging pass. */
export async function redraftReviewRound(key: string, opts: Opts = {}): Promise<string | undefined> {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (r && !['drafted', 'stale', 'failed'].includes(r.state)) return `${key}: the newest round is ${r.state}; only a drafted, stale or failed round re-drafts`;
  if (r?.staged) fs.rmSync(path.join(reviewRoundDir(key, r.id)!, 'staged.json'), { force: true });
  const out = redraftReview(key, opts.now);
  return typeof out === 'string' ? out : undefined;
}
