import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  classifyGhError,
  backendScopes,
  enqueue,
  firstMeaningfulLine,
  githubBlockedUntil,
  lastEventAt,
  latestRound,
  listReviews,
  loadConfig,
  observeReviewRequest,
  queuedDescriptor,
  readRoundDraft,
  readReview,
  readStatusLog,
  reconcile,
  recordGitHubRateLimit,
  recordGitHubResponse,
  requestCancel,
  reviewBrief,
  reviewCheckoutDir,
  reviewRoundDir,
  reviewSettings,
  splitGitHubResponse,
  withBriefHooks,
  withdrawUnseenReviews,
  writeReview,
} from '@lobstah/core';
import type { ReviewItem, ReviewRound } from '@lobstah/core';
import { githubRepoFromOrigin, loadPickupConfig } from '../config.js';
import { dispatchLane } from './report.js';
import { dismissReviewRound, redraftReviewRound, settleStagedReview, stageReview } from '../reviews-post.js';
import { claimReviewDocs, publishReviewDocs, reviewScope, runReviewRequests } from '../reviews-wharf.js';
import type { ReviewWharfOptions } from '../reviews-wharf.js';
import type { FetchLike } from '../reviews-post.js';

/**
 * One search per poll for open PRs whose review is requested from the
 * identity by name. `user-review-requested` matches direct requests only: a
 * request made only to a team the identity is on is not this account's to
 * answer. The newest ReviewRequestedEvent naming the identity is the round.
 */
export const REVIEW_SEARCH = `query($q: String!) {
  rateLimit { cost }
  search(query: $q, type: ISSUE, first: 50) {
    issueCount
    nodes {
      ... on PullRequest {
        number url title isDraft headRefOid
        author { login avatarUrl ... on User { name } }
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
          nodes { ... on ReviewRequestedEvent { id createdAt actor { __typename login avatarUrl ... on User { name } } requestedReviewer { __typename ... on User { login } } } }
        }
      }
    }
  }
}`;

export function reviewSearchQuery(identity: string): string {
  return `is:pr is:open user-review-requested:${identity} archived:false`;
}

interface SearchPr {
  number?: number;
  url?: string;
  title?: string;
  isDraft?: boolean;
  headRefOid?: string;
  author?: { login?: string; name?: string; avatarUrl?: string } | null;
  repository?: { nameWithOwner?: string };
  labels?: { nodes?: Array<{ name?: string }> };
  timelineItems?: {
    nodes?: Array<{ id?: string; createdAt?: string; actor?: { __typename?: string; login?: string; name?: string; avatarUrl?: string } | null; requestedReviewer?: { __typename?: string; login?: string } | null }>;
  };
}

export type GhGraphql = (
  body: { query: string; variables: Record<string, unknown> },
  token: string,
) => { status: number | null; stdout: string; stderr?: string; error?: Error };

const runGraphql: GhGraphql = (body, token) =>
  spawnSync('gh', ['api', 'graphql', '--include', '--input', '-'], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GH_TOKEN: token },
  });

/** `owner/name` (lowercase) → configured repo key, for every `[repos.*]` with a GitHub origin. */
function configuredRepos(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, repo] of Object.entries(loadConfig().repos)) {
    const forge = repo.origin ? githubRepoFromOrigin(repo.origin) : undefined;
    if (forge && !out.has(forge.toLowerCase())) out.set(forge.toLowerCase(), key);
  }
  return out;
}

/**
 * The reviews loop: search, file a round per new request, withdraw what the
 * search stopped returning. Off (`[reviews].enabled = false`) it makes no
 * call. It spends one request per cycle on the shared GitHub budget, and
 * skips the cycle while that budget is blocked.
 */
export async function reviewsLoop(
  identity: string,
  token: () => string,
  log: (m: string) => void = () => {},
  opts: { run?: GhGraphql; fetch?: FetchLike; now?: number; wharf?: ReviewWharfOptions } = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.reviews.enabled) return;
  const now = opts.now ?? Date.now();
  const gh = { token, ...(opts.fetch ? { fetch: opts.fetch } : {}), now };
  const wharf = Object.values(cfg.grounds).some((g) => g.wharf);
  const w = { ...opts.wharf, now };
  // The search needs the budget; drafting is local and runs either way.
  if (!githubBlockedUntil(now)) {
    const found = searchReviews(identity, token, log, opts.run ?? runGraphql, now);
    if (found) await settleGone(found, gh, log);
  }
  // On wharf grounds, a round is claimed (its document created) before it is drafted.
  if (wharf) await claimReviewDocs(log, w);
  draftReviews(identity, log, now);
  if (!githubBlockedUntil(now)) await postOrStage(gh, log);
  if (wharf) {
    await runReviewRequests(log, { ...w, dismiss: (key) => dismissReviewRound(key, 'hosted', gh) });
    await publishReviewDocs(log, w);
  }
}

/**
 * The search stopped returning these items. A staged round may be gone
 * because the person sent the review from their tool (that removes the
 * request): check it first, so it reads posted, not withdrawn. Then
 * withdraw the open rounds left.
 */
async function settleGone(found: { seen: Set<string>; inScope: (item: ReviewItem) => boolean }, gh: { token: () => string; fetch?: FetchLike; now: number }, log: (m: string) => void): Promise<void> {
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (found.seen.has(item.key) || !r?.staged || (r.state !== 'drafted' && r.state !== 'stale') || !found.inScope(item)) continue;
    const out = await settleStagedReview(item.key, gh);
    if (out === 'posted') log(`${item.key}: review sent from the review tool`);
    if (out === 'deleted') log(`${item.key}: pending review deleted in the review tool; round dismissed`);
  }
  for (const key of withdrawUnseenReviews(found.seen, found.inScope, gh.now)) log(`${key}: review request gone; round withdrawn`);
}

/**
 * A fresh draft is staged as the person's pending review, to edit and send
 * from their review tool. A stale draft is never staged on its own, and a failed attempt
 * is not retried on its own (the round keeps the reason).
 */
async function postOrStage(gh: { token: () => string; fetch?: FetchLike; now: number }, log: (m: string) => void): Promise<void> {
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (r?.state !== 'drafted' || r.staged || r.reason?.startsWith('post failed') || r.reason?.startsWith('stage failed')) continue;
      const out = await stageReview(item.key, gh);
      log(out.staged ? `${item.key}: draft staged as your pending review (${out.reviewId})` : `${item.key}: not staged: ${out.why}`);
  }
}

function searchReviews(identity: string, token: () => string, log: (m: string) => void, run: GhGraphql, now: number): { seen: Set<string>; inScope: (item: ReviewItem) => boolean } | undefined {
  const rc = loadConfig().reviews;
  const res = run({ query: REVIEW_SEARCH, variables: { q: reviewSearchQuery(identity) } }, token());
  const { headers, body } = splitGitHubResponse(res.stdout);
  let answer: { data?: { rateLimit?: { cost?: number }; search?: { issueCount?: number; nodes?: SearchPr[] } }; errors?: Array<{ message: string }> } = {};
  try {
    answer = JSON.parse(body);
  } catch {
    /* failure recorded below */
  }
  const reason =
    res.error?.message ?? answer.errors?.map((e) => e.message).join('; ') ?? firstMeaningfulLine(res.stderr) ?? `gh exited ${res.status}`;
  const limited = classifyGhError(reason).kind === 'rate-limit' || headers['x-ratelimit-remaining'] === '0';
  const search = answer.data?.search;
  recordGitHubResponse(headers, { now, cost: answer.data?.rateLimit?.cost, success: res.status === 0 && !limited && !!search });
  if (limited) {
    const retry = Number(headers['retry-after']);
    recordGitHubRateLimit(now, Number.isFinite(retry) && retry > 0 ? now + retry * 1000 : undefined);
    log('reviews: GitHub rate limit reached; the search waits for the budget');
    return undefined;
  }
  if (res.status !== 0 || !search) {
    log(`reviews: search failed: ${reason}`);
    return undefined;
  }

  const repos = configuredRepos();
  const inScope = (nwo: string): boolean => rc.repos === 'any' || repos.has(nwo.toLowerCase());
  const me = identity.toLowerCase();
  const seen = new Set<string>();
  const nodes = search.nodes ?? [];
  for (const pr of nodes) {
    const nwo = pr.repository?.nameWithOwner;
    const [owner, repo] = nwo?.split('/') ?? [];
    if (!nwo || !owner || !repo || !pr.number || !pr.url || !pr.headRefOid || !inScope(nwo)) continue;
    const request = (pr.timelineItems?.nodes ?? [])
      .filter((e) => e.id && e.createdAt && e.requestedReviewer?.__typename === 'User' && e.requestedReviewer.login?.toLowerCase() === me)
      .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!))
      .at(-1);
    if (!request) continue; // a team request only
    const repoKey = repos.get(nwo.toLowerCase());
    const author = pr.author?.login ?? '';
    const labels = (pr.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean);
    const settings = reviewSettings(rc, repoKey);
    const skipLabel = labels.find((l) => settings.skipLabels.includes(l));
    const skip = settings.skipAuthors.includes(author) ? `skipped: author ${author} is in skipAuthors` : skipLabel ? `skipped: label ${skipLabel} is in skipLabels` : undefined;
    const { item, opened } = observeReviewRequest(
      {
        pr: {
          owner,
          repo,
          number: pr.number,
          url: pr.url,
          title: pr.title ?? '',
          author,
          ...(pr.author?.name ? { authorName: pr.author.name } : {}),
          ...(pr.author?.avatarUrl ? { authorAvatarUrl: pr.author.avatarUrl } : {}),
          headSha: pr.headRefOid,
          ...(labels.length ? { labels } : {}),
          ...(pr.isDraft ? { draft: true } : {}),
          ...(repoKey ? { repoKey } : {}),
        },
        round: {
          id: request.id!, requestedAt: request.createdAt!,
          ...(request.actor?.login ? { requestedBy: request.actor.login } : {}),
          ...(request.actor?.name ? { requestedByName: request.actor.name } : {}),
          ...(request.actor?.avatarUrl ? { requestedByAvatarUrl: request.actor.avatarUrl } : {}),
          requestedAutomatically: request.actor?.__typename === 'Bot' || /(?:\[bot\]$|^github-actions$)/i.test(request.actor?.login ?? ''),
        },
        ...(skip ? { skip } : {}),
      },
      now,
    );
    seen.add(item.key);
    if (opened) log(`${item.key}: review requested${request.actor?.login ? ` by ${request.actor.login}` : ''}${skip ? ` (${skip})` : ''}`);
  }
  // A truncated search cannot say a request is gone.
  if ((search.issueCount ?? nodes.length) > nodes.length) return undefined;
  return { seen, inScope: (item: ReviewItem): boolean => inScope(`${item.pr.owner}/${item.pr.repo}`) };
}

// ── Drafting ────────────────────────────────────────────────────────────────

function verbOf(id: string): { lane: 'work' | 'chore'; verb: string; note?: string; at?: string } | undefined {
  const lane = dispatchLane(id);
  if (!lane) return undefined;
  const log = readStatusLog(id, lane);
  return { lane, verb: reconcile({ log, lastEventAt: lastEventAt(id, lane) }), note: log.at(-1)?.note, at: log.at(-1)?.at };
}

/** Jobs started on the UTC day of `now`, across every item. */
function startedToday(items: ReviewItem[], now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  return items.reduce((n, i) => n + i.rounds.reduce((m, r) => m + (r.draftStarts ?? (r.dispatchedAt ? [r.dispatchedAt] : [])).filter((at) => at.slice(0, 10) === day).length, 0), 0);
}

/** Why a requested round gets no job, or undefined when it gets one. */
function noJob(item: ReviewItem, round: ReviewRound, started: number): string | undefined {
  const rc = loadConfig().reviews;
  if (round.reason?.startsWith('skipped:')) return round.reason;
  if (!item.pr.repoKey) return 'no job: not a configured repo, so there is no checkout to review in';
  if (started >= rc.maxPerDay) return `no job: the daily cap ([reviews].maxPerDay = ${rc.maxPerDay}) is reached`;
  return undefined;
}

/**
 * Drafting, local and request-free: start a job for each requested round
 * that should have one, finish rounds whose job ended, hand a trap job to
 * the daemon when its trap wait expires, and cancel the job of a round the
 * request no longer stands for.
 */
export function draftReviews(identity: string, log: (m: string) => void = () => {}, now = Date.now(), manualKey?: string): void {
  const cfg = loadConfig();
  const items = listReviews();
  const scopes = backendScopes(cfg);
  let started = startedToday(items, now);
  for (const item of items) {
    if (manualKey && item.key !== manualKey) continue;
    const r = latestRound(item);
    if (!r) continue;
    const settings = { ...reviewSettings(cfg.reviews, item.pr.repoKey), ...(manualKey ? { work: 'trap' as const } : {}) };
    const save = () => writeReview({ ...item, updatedAt: new Date(now).toISOString() });

    // A withdrawn or dismissed round (the request went, a re-request superseded it, or the person dropped it) has its job cancelled, then its checkout removed once the job ends.
    for (const old of item.rounds) {
      if ((old.state !== 'withdrawn' && old.state !== 'dismissed') || !old.dispatch) continue;
      const oldJob = verbOf(old.dispatch);
      if (oldJob && oldJob.verb !== 'done' && oldJob.verb !== 'failed') {
        try {
          requestCancel(old.dispatch, oldJob.lane);
          log(`${item.key}: round ${old.state}; cancelled the review job ${old.dispatch}`);
        } catch {
          // still queued or already gone
        }
      } else removeReviewCheckout(item, old, log);
    }

    if (r.state === 'requested' && !r.dispatch) {
      // On wharf grounds, only the boat whose document it is drafts the round, once the document exists.
      if (reviewScope(item, scopes) && !r.wharf?.mine) continue;
      const why = settings.work === 'off' ? undefined : noJob(item, r, started);
      if (settings.work === 'off' || why) {
        if (why && r.reason !== why) {
          r.reason = why;
          save();
        }
        continue;
      }
      const outDir = reviewRoundDir(item.key, r.id);
      if (!outDir) continue;
      fs.mkdirSync(outDir, { recursive: true });
      const id = randomUUID();
      const trap = settings.work === 'trap' && settings.trapWaitSecs > 0;
      enqueue(
        {
          id,
          repo: item.pr.repoKey!,
          brief: withBriefHooks(reviewBrief(item, r, { identity, id, outDir, checkout: reviewCheckoutDir(item.key, r.id)! }), cfg, item.pr.repoKey, 'prReview'),
          readOnly: true,
          ...(settings.harness ? { harness: settings.harness } : {}),
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.effort ? { effort: settings.effort } : {}),
          limits: settings.limits,
          ...(trap ? { trapAny: true, systemRepair: { trapWaitUntil: new Date(now + settings.trapWaitSecs * 1000).toISOString() } } : {}),
        },
        'chore',
      );
      const at = new Date(now).toISOString();
      r.draftStarts = [...(r.draftStarts ?? (r.dispatchedAt ? [r.dispatchedAt] : [])), at];
      Object.assign(r, { state: 'drafting', dispatch: id, dispatchedAt: at });
      if (manualKey) r.draftOnly = true;
      delete r.reason;
      save();
      started++;
      log(`${item.key}: drafting the review as ${id}${trap ? ' (a free trap first)' : ''}`);
      continue;
    }

    if (!r.dispatch || r.state !== 'drafting') continue;
    const job = verbOf(r.dispatch);
    const ended = job?.verb === 'done' || job?.verb === 'failed';
    if (!job) {
      Object.assign(r, { state: 'failed', reason: 'the review job is gone (culled before it finished)' });
      save();
      removeReviewCheckout(item, r, log);
      continue;
    }
    if (!ended) {
      const queued = queuedDescriptor(r.dispatch, 'chore');
      const until = queued?.systemRepair?.trapWaitUntil;
      if (queued?.trapAny && until && now >= Date.parse(until)) {
        enqueue({ ...queued, trapAny: undefined, systemRepair: {} }, 'chore');
        log(`${item.key}: no trap took the review job in time; the daemon runs it`);
      }
      continue;
    }
    if (job.verb === 'failed') {
      Object.assign(r, { state: 'failed', reason: `the review job failed${job.note ? `: ${job.note}` : ''}` });
      save();
      removeReviewCheckout(item, r, log);
      log(`${item.key}: review job failed`);
      continue;
    }
    const draft = readRoundDraft(item.key, r.id);
    if ('error' in draft) {
      Object.assign(r, { state: 'failed', reason: `the review job finished without a usable draft: ${draft.error}` });
    } else {
      Object.assign(r, { state: 'drafted', draftedAt: job.at ?? new Date(now).toISOString() });
      delete r.reason;
      // The head moved while the job ran: the draft reviews an older head.
      if (r.headSha !== item.pr.headSha) Object.assign(r, { state: 'stale', reason: `the head moved to ${item.pr.headSha.slice(0, 7)} while the review was drafted` });
    }
    save();
    removeReviewCheckout(item, r, log);
    log(`${item.key}: review ${r.state}`);
  }
}

/** Draft one requested, stale, or failed round immediately, even in notification-only mode. */
export async function draftReviewOnDemand(key: string, now = Date.now()): Promise<string | undefined> {
  if (loadConfig().reviews.mode === 'notify') return 'reviews are in notify mode; switch to on-demand or auto to draft';
  const item = readReview(key);
  const round = item && latestRound(item);
  if (!item || !round) return `no review item ${key}`;
  if (!['requested', 'stale', 'failed'].includes(round.state) || (round.state === 'requested' && round.dispatch)) return `${key}: this round is already ${round.state}`;
  const why = noJob(item, round, startedToday(listReviews(), now));
  if (why) return why;
  const identity = loadPickupConfig().reviews?.identity;
  if (!identity) return 'reviews are not enabled; run lobstah setup reviews';
  if (round.state !== 'requested') {
    const why = await redraftReviewRound(key, { now });
    if (why) return why;
  }
  draftReviews(identity, () => {}, now, key);
  return latestRound(readReview(key)!)?.state === 'drafting' ? undefined : 'the round could not start drafting';
}

/**
 * Remove a round's throwaway checkout of the PR head, once its job has
 * ended: `git worktree remove --force`, then `git worktree prune`, in the
 * repo the job ran against. A no-op when the path is absent. A directory git
 * no longer knows as a worktree is deleted outright.
 */
export function removeReviewCheckout(item: ReviewItem, round: ReviewRound, log: (m: string) => void = () => {}): void {
  const dir = reviewCheckoutDir(item.key, round.id);
  if (!dir || !fs.existsSync(dir)) return;
  const repo = item.pr.repoKey ? loadConfig().repos[item.pr.repoKey]?.path : undefined;
  const git = (...args: string[]) => (repo ? spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true }) : undefined);
  git('worktree', 'remove', '--force', dir);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git('worktree', 'prune');
  log(`${item.key}: removed the review checkout of round ${round.id}`);
}
