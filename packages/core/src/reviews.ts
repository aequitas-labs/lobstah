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
  /** The review job's dispatch id. */
  dispatch?: string;
  draftedAt?: string;
  postedAt?: string;
  postedReviewId?: string;
  /** Who posted or dismissed it (`glass`, `cli`, `auto`). */
  by?: string;
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
