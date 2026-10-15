import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { uniqueTempPath, atomicRenameSync, lobstahHome } from './paths.js';
import type { DispatchLimits } from './types.js';
import type { TendAttention } from './glass.js';

/**
 * Review requests: a PR on which someone asked the configured identity
 * (`[pickup.github].identity`) for a review. `lobstah pick` finds them with
 * one search per poll and files a review item per PR here, in
 * `~/.lobstah/reviews/<owner>-<repo>-<n>/review.json`. An item holds
 * rounds: one per request event, so a re-request opens a new round and the
 * same standing request never opens two.
 */

export const REVIEW_WORK = ['off', 'trap', 'headless'] as const;
export type ReviewWork = (typeof REVIEW_WORK)[number];
export const REVIEW_POST = ['draft', 'auto'] as const;
export type ReviewPost = (typeof REVIEW_POST)[number];

/** The settings a repo can override under `[repos.<key>.reviews]`. */
export interface ReviewSettings {
  /** Who drafts: no one, a free trap of the repo (then headless after trapWaitSecs), or headless. */
  work: ReviewWork;
  /** `draft`: Chris posts from the glass. `auto`: post the draft as a comment-only review once drafted. */
  post: ReviewPost;
  harness?: string;
  model?: string;
  effort?: string;
  limits: DispatchLimits;
  trapWaitSecs: number;
  /** Requests on PRs by these authors, or with these labels, file an item but start no job. */
  skipAuthors: string[];
  skipLabels: string[];
  /** The person's own review rules (markdown), added to every review brief; a repo's own rules files are read too. */
  rules?: string;
}

export interface ReviewsConfig extends ReviewSettings {
  /** Opt-in. Off means no search call at all. */
  enabled: boolean;
  /** `configured`: only PRs in a `[repos.*]` origin. `any`: every repo the token can see. */
  repos: 'configured' | 'any';
  /** Review jobs started per day. */
  maxPerDay: number;
  /** `[repos.<key>.reviews]` overrides, by repo key. */
  perRepo: Record<string, Partial<ReviewSettings>>;
}

export const DEFAULT_REVIEWS: ReviewsConfig = {
  enabled: false,
  repos: 'configured',
  work: 'trap',
  post: 'draft',
  limits: { wallClockSecs: 900, maxTurns: 40 },
  trapWaitSecs: 600,
  maxPerDay: 20,
  skipAuthors: [],
  skipLabels: [],
  perRepo: {},
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${where} must be ${allowed.map((a) => `"${a}"`).join(', ')}`);
}

function nonNegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${where} must be a non-negative number`);
  return value;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings`);
  return value.map(String);
}

function parseSettings(raw: Record<string, unknown>, where: string): Partial<ReviewSettings> {
  const out: Partial<ReviewSettings> = {};
  if (raw.work !== undefined) out.work = oneOf(raw.work, REVIEW_WORK, `${where}.work`);
  if (raw.post !== undefined) out.post = oneOf(raw.post, REVIEW_POST, `${where}.post`);
  for (const k of ['harness', 'model', 'effort'] as const) if (raw[k] !== undefined) out[k] = String(raw[k]);
  const limits: DispatchLimits = {};
  for (const k of ['wallClockSecs', 'maxTurns', 'maxBudgetUsd'] as const) if (raw[k] !== undefined) limits[k] = nonNegative(raw[k], `${where}.${k}`);
  if (Object.keys(limits).length) out.limits = limits;
  if (raw.trapWaitSecs !== undefined) out.trapWaitSecs = nonNegative(raw.trapWaitSecs, `${where}.trapWaitSecs`);
  if (raw.skipAuthors !== undefined) out.skipAuthors = strings(raw.skipAuthors, `${where}.skipAuthors`);
  if (raw.skipLabels !== undefined) out.skipLabels = strings(raw.skipLabels, `${where}.skipLabels`);
  if (raw.rules !== undefined) {
    if (typeof raw.rules !== 'string' || raw.rules.length > 20000) throw new Error(`${where}.rules must be text of at most 20000 characters`);
    if (raw.rules.trim()) out.rules = raw.rules.trim();
  }
  return out;
}

/** `[reviews]` and every `[repos.<key>.reviews]`. Throws on a malformed value. */
export function parseReviews(raw: unknown, reposRaw: Record<string, Record<string, unknown>> = {}): ReviewsConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r !== 'object' || Array.isArray(r)) throw new Error('[reviews] must be a table');
  const base = parseSettings(r, '[reviews]');
  const perRepo: Record<string, Partial<ReviewSettings>> = {};
  for (const [key, repo] of Object.entries(reposRaw)) {
    if (repo.reviews !== undefined) perRepo[key] = parseSettings(repo.reviews as Record<string, unknown>, `[repos.${key}.reviews]`);
  }
  return {
    ...DEFAULT_REVIEWS,
    ...base,
    limits: { ...DEFAULT_REVIEWS.limits, ...base.limits },
    enabled: r.enabled === undefined ? false : Boolean(r.enabled),
    repos: r.repos === undefined ? 'configured' : oneOf(r.repos, ['configured', 'any'] as const, '[reviews].repos'),
    maxPerDay: r.maxPerDay === undefined ? DEFAULT_REVIEWS.maxPerDay : nonNegative(r.maxPerDay, '[reviews].maxPerDay'),
    perRepo,
  };
}

/** The settings for one repo: its overrides over `[reviews]`. */
export function reviewSettings(cfg: ReviewsConfig, repoKey?: string): ReviewSettings {
  const o = (repoKey && cfg.perRepo[repoKey]) || {};
  const { enabled: _e, repos: _r, maxPerDay: _m, perRepo: _p, ...base } = cfg;
  return { ...base, ...o, limits: { ...base.limits, ...o.limits } };
}

// ── The item store ─────────────────────────────────────────────────────────

export const REVIEW_ROUND_STATES = ['requested', 'drafting', 'drafted', 'stale', 'failed', 'posted', 'dismissed', 'withdrawn'] as const;
export type ReviewRoundState = (typeof REVIEW_ROUND_STATES)[number];

export interface ReviewRound {
  /** The request event's id: one round per request. */
  id: string;
  requestedAt: string;
  requestedBy?: string;
  /** The head the round reviews. */
  headSha: string;
  state: ReviewRoundState;
  /** The review job's dispatch id, and when it started (the daily cap counts these). */
  dispatch?: string;
  dispatchedAt?: string;
  draftedAt?: string;
  postedAt?: string;
  postedReviewId?: string;
  /** Who posted or dismissed it (`cli`, `auto`, `glass`, `review tool`). */
  by?: string;
  /**
   * The draft is staged on the PR as a pending GitHub review, which only
   * the configured identity sees: the person opens the PR in their review
   * tool, edits it, and sends it from there.
   */
  staged?: { reviewId: string; at: string };
  /** Why the round is where it is: a skip rule, the daily cap, a failure, a withdrawal. */
  reason?: string;
}

export interface ReviewPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  /** The PR's head as last observed. */
  headSha: string;
  labels?: string[];
  draft?: boolean;
  /** The configured repo key, when the PR is in one. */
  repoKey?: string;
}

export interface ReviewItem {
  key: string;
  pr: ReviewPr;
  rounds: ReviewRound[];
  updatedAt: string;
}

/** Rounds in these states are still open: a vanished request withdraws them. */
const OPEN_STATES: readonly ReviewRoundState[] = ['requested', 'drafting', 'drafted', 'stale', 'failed'];

export function reviewKey(owner: string, repo: string, number: number): string {
  return `review:${owner}/${repo}#${number}`;
}

function parseKey(key: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^review:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(key);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : undefined;
}

export function reviewsRoot(): string {
  return path.join(lobstahHome(), 'reviews');
}

/** The directory a review key names, or undefined for a malformed key. Never a path the key spells. */
export function reviewDir(key: string): string | undefined {
  const k = parseKey(key);
  return k ? path.join(reviewsRoot(), `${k.owner}-${k.repo}-${k.number}`) : undefined;
}

export function readReview(key: string): ReviewItem | undefined {
  const dir = reviewDir(key);
  if (!dir) return undefined;
  try {
    const item = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8')) as ReviewItem;
    return item.key === key && Array.isArray(item.rounds) ? item : undefined;
  } catch {
    return undefined;
  }
}

export function writeReview(item: ReviewItem): ReviewItem {
  const dir = reviewDir(item.key);
  if (!dir) throw new Error(`malformed review key ${item.key}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'review.json');
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(item, null, 2)}\n`);
  atomicRenameSync(tmp, file);
  return item;
}

/** Every review item, newest change first. */
export function listReviews(): ReviewItem[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(reviewsRoot());
  } catch {
    return [];
  }
  const out: ReviewItem[] = [];
  for (const d of dirs) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(reviewsRoot(), d, 'review.json'), 'utf8')) as ReviewItem;
      if (reviewDir(item.key) === path.join(reviewsRoot(), d)) out.push(item);
    } catch {
      // not a review item
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function latestRound(item: ReviewItem): ReviewRound | undefined {
  return item.rounds.at(-1);
}

export interface ReviewRequestSeen {
  pr: ReviewPr;
  round: { id: string; requestedAt: string; requestedBy?: string };
  /** A skip rule matched: the round files, and no job starts. */
  skip?: string;
}

/**
 * Record one search result. A request event the item has not seen opens a
 * round (an open earlier round is withdrawn as superseded). The same event
 * changes only the PR's fields: a moved head updates a requested round, and
 * makes a drafted one stale. Returns the item and whether a round opened.
 */
export function observeReviewRequest(seen: ReviewRequestSeen, now = Date.now()): { item: ReviewItem; opened: boolean } {
  const key = reviewKey(seen.pr.owner, seen.pr.repo, seen.pr.number);
  const at = new Date(now).toISOString();
  const prior = readReview(key);
  const item: ReviewItem = prior ? { ...prior, pr: seen.pr, rounds: [...prior.rounds] } : { key, pr: seen.pr, rounds: [], updatedAt: at };
  const known = item.rounds.find((r) => r.id === seen.round.id);
  if (known) {
    const latest = latestRound(item)!;
    if (latest === known && known.headSha !== seen.pr.headSha) {
      if (known.state === 'requested') known.headSha = seen.pr.headSha;
      else if (known.state === 'drafted') {
        known.state = 'stale';
        known.reason = `the head moved to ${seen.pr.headSha.slice(0, 7)} after the draft`;
      }
    }
    const changed = JSON.stringify(prior) !== JSON.stringify({ ...item, updatedAt: prior!.updatedAt });
    if (changed) writeReview({ ...item, updatedAt: at });
    return { item: changed ? { ...item, updatedAt: at } : prior!, opened: false };
  }
  for (const r of item.rounds) {
    if (OPEN_STATES.includes(r.state) && r.state !== 'drafting') {
      r.state = 'withdrawn';
      r.reason = 'superseded by a new request';
    }
  }
  item.rounds.push({
    id: seen.round.id,
    requestedAt: seen.round.requestedAt,
    ...(seen.round.requestedBy ? { requestedBy: seen.round.requestedBy } : {}),
    headSha: seen.pr.headSha,
    state: 'requested',
    ...(seen.skip ? { reason: seen.skip } : {}),
  });
  return { item: writeReview({ ...item, updatedAt: at }), opened: true };
}

/**
 * The search no longer returns these items (the request was withdrawn, the
 * PR closed or merged, or Chris reviewed it on GitHub): their open newest
 * round is withdrawn. A drafted review is kept for reading, never posted.
 * `inScope` limits it to items the search could have returned.
 */
export function withdrawUnseenReviews(seen: ReadonlySet<string>, inScope: (item: ReviewItem) => boolean, now = Date.now()): string[] {
  const out: string[] = [];
  const at = new Date(now).toISOString();
  for (const item of listReviews()) {
    const latest = latestRound(item);
    if (seen.has(item.key) || !latest || !OPEN_STATES.includes(latest.state) || !inScope(item)) continue;
    latest.state = 'withdrawn';
    latest.reason = 'the request is gone: withdrawn, reviewed on GitHub, or the PR closed';
    writeReview({ ...item, updatedAt: at });
    out.push(item.key);
  }
  return out;
}

// ── Drafts ─────────────────────────────────────────────────────────────────

/** One inline comment: a line of the PR head's version of a file. */
export interface ReviewComment {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

/** Where a round's draft lives: `review.md` (the summary body) and `comments.json` (inline comments). */
export function reviewRoundDir(key: string, roundId: string): string | undefined {
  const dir = reviewDir(key);
  return dir && /^[A-Za-z0-9_-]+$/.test(roundId) ? path.join(dir, 'rounds', roundId) : undefined;
}

/** Inline comments from JSON, or why they are malformed. */
export function parseReviewComments(raw: unknown): ReviewComment[] | string {
  if (!Array.isArray(raw)) return 'comments.json is not a JSON array';
  const out: ReviewComment[] = [];
  for (const [i, c] of raw.entries()) {
    const x = c as Record<string, unknown>;
    if (typeof x?.path !== 'string' || !x.path || !Number.isSafeInteger(x.line) || (x.line as number) < 1 || typeof x.body !== 'string' || !x.body.trim()) {
      return `comments.json entry ${i} needs path, a positive line, and a body`;
    }
    if (x.side !== undefined && x.side !== 'LEFT' && x.side !== 'RIGHT') return `comments.json entry ${i}: side must be LEFT or RIGHT`;
    out.push({ path: x.path, line: x.line as number, ...(x.side ? { side: x.side as 'LEFT' | 'RIGHT' } : {}), body: x.body });
  }
  return out;
}

/** A round's draft as its job wrote it, or why it cannot be read. A missing comments.json is no inline comments. */
export function readRoundDraft(key: string, roundId: string): { body: string; comments: ReviewComment[] } | { error: string } {
  const dir = reviewRoundDir(key, roundId);
  if (!dir) return { error: 'malformed review key or round id' };
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  } catch {
    return { error: `no review.md in ${dir}` };
  }
  if (!body.trim()) return { error: 'review.md is empty' };
  let comments: ReviewComment[] | string = [];
  const file = path.join(dir, 'comments.json');
  if (fs.existsSync(file)) {
    try {
      comments = parseReviewComments(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      comments = 'comments.json is not valid JSON';
    }
  }
  return typeof comments === 'string' ? { error: comments } : { body, comments };
}

/** The `prReview` brief: draft, never post. */
export function reviewBrief(item: ReviewItem, round: ReviewRound, opts: { identity: string; id: string; outDir: string; rules?: string }): string {
  const { owner, repo, number, url, title, author } = item.pr;
  const ref = `${number} --repo ${owner}/${repo}`;
  return [
    `Draft a review of ${url} ("${title}" by ${author}) at head ${round.headSha}. ${round.requestedBy ?? 'Someone'} asked ${opts.identity} for this review. You write the draft; you do not post it.`,
    '',
    `1. Read the PR: \`gh pr view ${ref} --comments\` and \`gh pr diff ${ref}\`.`,
    `2. For context beyond the diff, make a throwaway checkout at the PR head and remove it when you are done: \`git fetch origin pull/${number}/head\`, then \`git worktree add --detach <tmpdir> FETCH_HEAD\`, and at the end \`git worktree remove --force <tmpdir>\`. Never switch, commit to, or push this checkout's own branch.`,
    "3. Follow the repo's own rules: read any review guidance at the PR head (REVIEW.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md, .github/pull_request_template.md) and hold the change to it.",
    `4. Review it the way the reviewer would: correctness first, then risk, then clarity. No style nits unless they hide a bug.${opts.rules ? ' Follow the review rules below too.' : ''}`,
    `5. Write two files in ${opts.outDir}: \`review.md\`, the review's summary body in markdown; and \`comments.json\`, the inline comments as a JSON array of \`{"path": "<file>", "line": <line in the PR head's version>, "side": "RIGHT", "body": "<markdown>"}\` (\`[]\` when there are none).`,
    '6. Do not post, approve, request changes, comment on, push to, or edit the PR. If you cannot review it (too large, missing context), say so in review.md.',
    `7. Report done: \`lobstah report ${opts.id} done "<one line>"\`.`,
    ...(opts.rules ? ['', `Review rules from ${opts.identity}:`, '', opts.rules] : []),
  ].join('\n');
}

/**
 * Re-draft a stale or failed round: it becomes requested again at the PR's
 * current head, and the next pick cycle starts a job for it. Returns the
 * item, or why it cannot.
 */
export function redraftReview(key: string, now = Date.now()): ReviewItem | string {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (!item || !r) return `no review item ${key}`;
  if (r.state !== 'stale' && r.state !== 'failed') return `${key}: the newest round is ${r.state}; only a stale or failed round re-drafts`;
  const { dispatch: _d, dispatchedAt: _a, draftedAt: _t, reason: _r, staged: _s, ...rest } = r;
  item.rounds[item.rounds.length - 1] = { ...rest, state: 'requested', headSha: item.pr.headSha };
  return writeReview({ ...item, updatedAt: new Date(now).toISOString() });
}

/** The hidden marker a posted review ends with: one per round, so a second post of it can be found. */
export function reviewMarker(roundId: string): string {
  return `<!-- lobstah:review ${roundId} -->`;
}

/** Dismiss the newest round: nothing is posted, and it leaves attention. A drafting job is cancelled by the next pick cycle; a staged pending review is the caller's to delete first (pick's dismissReviewRound). */
export function dismissReview(key: string, by: string, now = Date.now()): ReviewItem | string {
  const item = readReview(key);
  const r = item && latestRound(item);
  if (!item || !r) return `no review item ${key}`;
  if (!OPEN_STATES.includes(r.state)) return `${key}: the newest round is already ${r.state}`;
  Object.assign(r, { state: 'dismissed', by });
  delete r.reason;
  return writeReview({ ...item, updatedAt: new Date(now).toISOString() });
}

/** Record a posted round (`posted.json` is the post's write-once receipt; this is the item's view). */
export function markReviewPosted(key: string, roundId: string, post: { reviewId: string; by: string; at: string }): ReviewItem | undefined {
  const item = readReview(key);
  const r = item?.rounds.find((x) => x.id === roundId);
  if (!item || !r) return undefined;
  Object.assign(r, { state: 'posted', postedAt: post.at, postedReviewId: post.reviewId, by: post.by });
  delete r.reason;
  delete r.staged;
  return writeReview({ ...item, updatedAt: post.at });
}

// ── Attention ──────────────────────────────────────────────────────────────

/** Whether a round asks for Chris: drafted, stale, failed, or requested with no job to draft it. */
export function reviewStands(round: ReviewRound | undefined): boolean {
  if (!round) return false;
  if (round.state === 'requested') return round.dispatch === undefined;
  return round.state === 'drafted' || round.state === 'stale' || round.state === 'failed';
}

export function reviewStateHash(item: ReviewItem): string {
  const r = latestRound(item);
  return createHash('sha1')
    .update(`${item.key}\n${r?.id ?? ''}\n${r?.state ?? ''}\n${r?.headSha ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** One `review` attention item per PR whose newest round stands. */
export function reviewAttention(now: number, items: ReviewItem[] = listReviews()): TendAttention[] {
  const out: TendAttention[] = [];
  for (const item of items) {
    const r = latestRound(item);
    if (!r || !reviewStands(r)) continue;
    out.push({
      kind: 'review',
      key: item.key,
      stateHash: reviewStateHash(item),
      id: item.key,
      lane: 'chore',
      verb: r.state,
      ageSecs: Math.max(0, Math.round((now - Date.parse(r.requestedAt)) / 1000)),
      at: r.requestedAt,
      standingSince: r.draftedAt ?? r.requestedAt,
      note: `${item.pr.owner}/${item.pr.repo}#${item.pr.number} ${item.pr.title}${r.requestedBy ? ` (asked by ${r.requestedBy})` : ''}`,
      ...(item.pr.repoKey ? { repo: item.pr.repoKey } : {}),
      prUrl: item.pr.url,
      number: item.pr.number,
      headSha: r.headSha,
    });
  }
  return out;
}
