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
export const REVIEW_MODES = ['notify', 'on-demand', 'auto-draft', 'auto-review'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** The settings a repo can override under `[repos.<key>.reviews]`. */
export interface ReviewSettings {
  mode: ReviewMode;
  publish: boolean;
  /** Who drafts: no one, a free trap of the repo (then headless after trapWaitSecs), or headless. */
  work: ReviewWork;
  /** `draft`: stage the draft as the identity's pending review, sent from the review tool. `auto`: publish by verdict once drafted; approval always waits for a person. */
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
  mode: ReviewMode;
  identity?: string;
  tokenCommand?: string;
  tokenEnv?: string;
  tokenFile?: string;
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
  mode: 'notify',
  publish: false,
  repos: 'configured',
  work: 'off',
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
  if (raw.mode !== undefined) out.mode = oneOf(raw.mode, REVIEW_MODES, `${where}.mode`);
  else if (raw.post === 'auto') out.mode = 'auto-review';
  else if (raw.work === 'off') out.mode = 'on-demand';
  else if (raw.work !== undefined || raw.post !== undefined) out.mode = 'auto-draft';
  if (raw.publish !== undefined) {
    if (typeof raw.publish !== 'boolean') throw new Error(`${where}.publish must be a boolean`);
    out.publish = raw.publish;
  }
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
  const requestedMode = base.mode ?? 'notify';
  const publish = base.publish ?? (requestedMode === 'auto-review');
  const mode = requestedMode.startsWith('auto-') ? (publish ? 'auto-review' : 'auto-draft') : requestedMode;
  const perRepo: Record<string, Partial<ReviewSettings>> = {};
  for (const [key, repo] of Object.entries(reposRaw)) {
    if (repo.reviews !== undefined) perRepo[key] = parseSettings(repo.reviews as Record<string, unknown>, `[repos.${key}.reviews]`);
  }
  return {
    ...DEFAULT_REVIEWS,
    ...base,
    mode,
    publish,
    work: mode.startsWith('auto-') ? (base.work && base.work !== 'off' ? base.work : 'trap') : 'off',
    post: publish ? 'auto' : 'draft',
    ...Object.fromEntries(['identity', 'tokenCommand', 'tokenEnv', 'tokenFile'].filter((k) => r[k] !== undefined).map((k) => [k, String(r[k])])),
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
  const { enabled: _e, mode: _mode, identity: _i, tokenCommand: _c, tokenEnv: _v, tokenFile: _f, repos: _r, maxPerDay: _m, perRepo: _p, ...base } = cfg;
  const requestedMode = o.mode ?? cfg.mode;
  const publish = o.publish ?? (o.mode === 'auto-draft' ? false : o.mode === 'auto-review' ? true : cfg.publish);
  const mode = requestedMode.startsWith('auto-') ? (publish ? 'auto-review' : 'auto-draft') : requestedMode;
  const work = mode.startsWith('auto-') ? (o.work && o.work !== 'off' ? o.work : base.work !== 'off' ? base.work : 'trap') : 'off';
  return { ...base, ...o, mode, publish, work, post: publish ? 'auto' : 'draft', limits: { ...base.limits, ...o.limits } };
}

// ── The item store ─────────────────────────────────────────────────────────

export const REVIEW_ROUND_STATES = ['requested', 'drafting', 'drafted', 'stale', 'failed', 'posted', 'dismissed', 'withdrawn'] as const;
export type ReviewRoundState = (typeof REVIEW_ROUND_STATES)[number];

export const REVIEW_VERDICTS = ['approve', 'comment', 'request_changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export interface BlockingFinding { path: string; line: number; body: string }
export interface ReviewNotification { kind: 'draft-ready' | 'needs-you' | 'published'; at: string; text: string }

/** Stable row target shared by notifications, the pet, and the glass. */
export const reviewHash = (key: string): string => `#review-${encodeURIComponent(key)}`;

export interface ReviewRound {
  /** The request event's id: one round per request. */
  id: string;
  requestedAt: string;
  requestedBy?: string;
  requestedByName?: string;
  requestedByAvatarUrl?: string;
  requestedAutomatically?: boolean;
  /** Compatibility receipt: a draft-only job must not be automatically submitted. */
  draftOnly?: boolean;
  /** Whether this job was explicitly started with publishing enabled. */
  publish?: boolean;
  verdict?: ReviewVerdict;
  blocking?: BlockingFinding[];
  needsYou?: boolean;
  seenAt?: string;
  acknowledgedAt?: string;
  notification?: ReviewNotification;
  notificationGeneration?: string;
  /** The head the round reviews. */
  headSha: string;
  state: ReviewRoundState;
  /** The review job's dispatch id, and when it started (the daily cap counts these). */
  dispatch?: string;
  dispatchedAt?: string;
  /** Start receipts survive redrafts so retries still count against the daily cap. */
  draftStarts?: string[];
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
  /**
   * On wharf grounds: the round's review document. `mine` is false when
   * another boat created it first (that boat drafts and posts the round);
   * `published` is the fingerprint last published.
   */
  wharf?: { doc: string; mine: boolean; published?: string };
}

export interface ReviewPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  authorName?: string;
  authorAvatarUrl?: string;
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
  round: Pick<ReviewRound, 'id' | 'requestedAt' | 'requestedBy' | 'requestedByName' | 'requestedByAvatarUrl' | 'requestedAutomatically'>;
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
  const item: ReviewItem = prior ? { ...prior, pr: seen.pr, rounds: prior.rounds.map((r) => ({ ...r })) } : { key, pr: seen.pr, rounds: [], updatedAt: at };
  const known = item.rounds.find((r) => r.id === seen.round.id);
  if (known) {
    Object.assign(known, seen.round);
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
  // A drafting round is superseded too: pick cancels its job, then removes its checkout.
  for (const r of item.rounds) {
    if (OPEN_STATES.includes(r.state)) {
      r.state = 'withdrawn';
      r.reason = 'superseded by a new request';
    }
  }
  item.rounds.push({
    ...seen.round,
    headSha: seen.pr.headSha,
    state: 'requested',
    ...(seen.skip ? { reason: seen.skip } : {}),
  });
  return { item: writeReview({ ...item, updatedAt: at }), opened: true };
}

/**
 * The search no longer returns these items (the request was withdrawn, the
 * PR closed or merged, or the person reviewed it on GitHub): their open newest
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

/**
 * Where a round's job makes its throwaway checkout of the PR head: a fixed
 * path in the round's directory, so pick can remove it when the job ends.
 */
export function reviewCheckoutDir(key: string, roundId: string): string | undefined {
  const dir = reviewRoundDir(key, roundId);
  return dir && path.join(dir, 'checkout');
}

/** A round's draft as its job wrote it, or why it cannot be read. A missing comments.json is no inline comments. */
export function readRoundDraft(key: string, roundId: string): { body: string; comments: ReviewComment[]; verdict: ReviewVerdict; blocking: BlockingFinding[] } | { error: string } {
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
  if (typeof comments === 'string') return { error: comments };
  // Older in-flight jobs wrote only the summary and comments. They remain
  // comment drafts; no missing metadata can ever imply approval.
  let verdict: ReviewVerdict = 'comment';
  let blocking: BlockingFinding[] = [];
  const meta = path.join(dir, 'verdict.json');
  if (fs.existsSync(meta)) {
    try {
      const raw = JSON.parse(fs.readFileSync(meta, 'utf8'));
      verdict = oneOf(raw.verdict, REVIEW_VERDICTS, 'verdict.json verdict');
      const findings = parseReviewComments(raw.blocking);
      if (typeof findings === 'string') return { error: `verdict.json blocking: ${findings}` };
      blocking = findings;
      if (verdict === 'approve' && blocking.length) return { error: 'an approve verdict cannot have blocking findings' };
      if (verdict === 'request_changes' && !blocking.length) return { error: 'request_changes needs blocking findings with file and line' };
      if (blocking.length) verdict = 'request_changes';
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'invalid verdict.json' };
    }
  }
  return { body, comments, verdict, blocking };
}

/** The `prReview` brief: draft, never post. */
export function reviewBrief(item: ReviewItem, round: ReviewRound, opts: { identity: string; id: string; outDir: string; checkout: string }): string {
  const { owner, repo, number, url, title, author } = item.pr;
  const ref = `${number} --repo ${owner}/${repo}`;
  return [
    `Draft a review of ${url} ("${title}" by ${author}) at head ${round.headSha}. ${round.requestedBy ?? 'Someone'} asked ${opts.identity} for this review. You write the draft; you do not post it.`,
    '',
    `1. Read the PR: \`gh pr view ${ref} --comments\` and \`gh pr diff ${ref}\`.`,
    `2. For context beyond the diff, make a throwaway checkout of the PR head at exactly ${opts.checkout}: \`git fetch origin pull/${number}/head\`, then \`git worktree add --detach ${opts.checkout} FETCH_HEAD\`. Use no other path; lobstah removes it when the job ends. Never switch, commit to, or push this checkout's own branch.`,
    "3. Follow the repo's own rules: read any review guidance at the PR head (REVIEW.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md, .github/pull_request_template.md) and hold the change to it.",
    '4. Review it the way the reviewer would: correctness first, then risk, then clarity. No style nits unless they hide a bug. Follow any review rules appended below this brief too.',
    `5. Write three files in ${opts.outDir}: \`review.md\`, the review's summary body in markdown; and \`comments.json\`, the inline comments as a JSON array of \`{"path": "<file>", "line": <line in the PR head's version>, "side": "RIGHT", "body": "<markdown>"}\` (\`[]\` when there are none); and \`verdict.json\` as \`{"verdict":"approve|comment|request_changes","blocking":[{"path":"<file>","line":<positive line>,"body":"<blocking finding>"}]}\`. Every blocking finding needs a file and line. Use request_changes for blockers, approve only when ready to merge, otherwise comment. Approve must have no blockers; request_changes must have at least one.`,
    '6. Do not post, approve, request changes, comment on, push to, or edit the PR. If you cannot review it (too large, missing context), say so in review.md.',
    `7. Report done: \`lobstah report ${opts.id} done "<one line>"\`.`,
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
  const { dispatch: _d, dispatchedAt: _a, draftedAt: _t, reason: _r, staged: _s, verdict: _v, blocking: _b, notification: _n, needsYou: _y, seenAt: _seen, acknowledgedAt: _ack, ...rest } = r;
  item.rounds[item.rounds.length - 1] = { ...rest, ...(_a && !rest.draftStarts ? { draftStarts: [_a] } : {}), state: 'requested', headSha: item.pr.headSha };
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
  delete r.needsYou;
  if (post.by !== 'auto') { delete r.notification; r.acknowledgedAt = post.at; }
  return writeReview({ ...item, updatedAt: post.at });
}

// ── Attention ──────────────────────────────────────────────────────────────

/** Whether a round waits on the person: drafted, stale, failed, or requested with no job to draft it; never a round another boat on the wharf has. */
export function reviewStands(round: ReviewRound | undefined): boolean {
  if (!round) return false;
  // Another boat on the wharf has this round: it waits on the person there, not here.
  if (round.wharf && !round.wharf.mine) return false;
  if (round.state === 'requested') return round.dispatch === undefined;
  return round.state === 'drafted' || round.state === 'stale' || round.state === 'failed';
}

export function reviewStateHash(item: ReviewItem): string {
  const r = latestRound(item);
  return createHash('sha1')
    .update(`${item.key}\n${r?.id ?? ''}\n${r?.state ?? ''}\n${r?.headSha ?? ''}\n${r?.notificationGeneration ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Opening is seen; only an explicit action clears notification and needs-you. */
export function markReviewSeen(key: string, now = Date.now()): boolean {
  const item = readReview(key); const r = item && latestRound(item);
  if (!item || !r) return false;
  r.seenAt = new Date(now).toISOString();
  writeReview({ ...item, updatedAt: r.seenAt });
  return true;
}

export function acknowledgeReview(key: string, now = Date.now()): boolean {
  const item = readReview(key); const r = item && latestRound(item);
  if (!item || !r) return false;
  r.acknowledgedAt = new Date(now).toISOString();
  delete r.notification; delete r.needsYou;
  writeReview({ ...item, updatedAt: r.acknowledgedAt });
  return true;
}

/** Pet-only review notifications. Requests never stand in tend or on deck. */
export function reviewAttention(now: number, items: ReviewItem[] = listReviews()): TendAttention[] {
  return items.flatMap(item => {
    const r = latestRound(item);
    if (!r?.notification || r.wharf || ['dismissed', 'withdrawn'].includes(r.state)) return [];
    return [{ kind: 'review' as const, key: item.key, stateHash: reviewStateHash(item), id: item.key,
      lane: 'chore' as const, verb: r.notification.kind, ageSecs: Math.max(0, Math.round((now - Date.parse(r.notification.at)) / 1000)),
      at: r.notification.at, standingSince: r.notification.at, note: r.notification.text,
      ...(item.pr.repoKey ? { repo: item.pr.repoKey } : {}), prUrl: item.pr.url, number: item.pr.number, headSha: r.headSha }];
  });
}

/** Create one notification per completed draft/publish generation; no request notifications. */
export function refreshReviewNotifications(now = Date.now()): Array<{ key: string; notification: ReviewNotification; hash: string }> {
  const events: Array<{ key: string; notification: ReviewNotification; hash: string }> = [];
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!r || r.wharf || !['drafted', 'posted'].includes(r.state)) continue;
    if (r.state === 'posted' && r.by !== 'auto') continue;
    const generation = `${r.id}:${r.dispatch ?? ''}:${r.state}:${r.postedAt ?? r.draftedAt ?? r.headSha}`;
    if (r.notificationGeneration === generation) continue;
    r.notificationGeneration = generation;
    const completed = r.postedAt ?? r.draftedAt;
    if (completed && r.acknowledgedAt && r.acknowledgedAt >= completed) {
      writeReview(item); continue;
    }
    const needsYou = r.state === 'drafted' && r.verdict === 'approve';
    r.needsYou = needsYou;
    delete r.seenAt;
    const verdict = (r.verdict ?? 'comment').replace('_', ' ');
    const kind = r.state === 'posted' ? 'published' : needsYou ? 'needs-you' : 'draft-ready';
    const label = kind === 'published' ? 'Published' : needsYou ? 'Draft ready (needs you)' : 'Draft ready';
    r.notification = { kind, at: new Date(now).toISOString(), text: `${label}: #${item.pr.number} · ${verdict} · ${r.blocking?.length ?? 0} blocking` };
    writeReview({ ...item, updatedAt: r.notification.at });
    events.push({ key: item.key, notification: r.notification, hash: reviewHash(item.key) });
  }
  return events;
}
