import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  classifyGhError,
  cancelQueued,
  reviewAutomationCutoff,
  reviewCanPublish,
  dispatchWasCancelled,
  backendScopes,
  enqueue,
  firstMeaningfulLine,
  githubBlockedUntil,
  lastEventAt,
  latestRound,
  markReviewPosted,
  isReviewBot,
  reviewAsker,
  listReviews,
  loadConfig,
  observeReviewRequest,
  queuedDescriptor,
  readRoundDraft,
  readReview,
  reviewKey,
  readStatusLog,
  reconcile,
  recordGitHubRateLimit,
  recordGitHubResponse,
  requestCancel,
  reviewBrief,
  reviewDraftCoversHead,
  acknowledgeReview,
  refreshReviewNotifications,
  reviewCheckoutDir,
  reviewRoundDir,
  reviewSettings,
  splitGitHubResponse,
  withBriefHooks,
  withdrawUnseenReviews,
  writeReview,
  carryReviewDecisionAnswers,
  unansweredReviewDecisions,
  newReviewRound,
} from '@lobstah/core';
import type { ReviewItem, ReviewRound, ReviewThread, ReviewVerdict } from '@lobstah/core';
import { githubRepoFromOrigin, loadPickupConfig } from '../config.js';
import { dispatchLane } from './report.js';
import { dismissReviewRound, postReview, redraftReviewRound, settleStagedReview, stageReview } from '../reviews-post.js';
import { claimReviewDocs, publishReviewDocs, reviewScope, runReviewRequests } from '../reviews-wharf.js';
import type { ReviewWharfOptions } from '../reviews-wharf.js';
import type { FetchLike } from '../reviews-post.js';
import { reapproveBaseUpdate, verifiedBaseUpdate } from '../reviews-reapprove.js';
import { currentReviewDiffId, reviewDiffId } from '../reviews-diff.js';

/**
 * One search per poll for open PRs whose review is requested from the
 * identity by name. `user-review-requested` matches direct requests only: a
 * request made only to a team the identity is on is not this account's to
 * answer. Requests and the identity's submitted reviews are read together,
 * so a re-request cannot redraft a head the person already reviewed.
 */
export const REVIEW_SEARCH = `query($q: String!, $identity: String!) {
  rateLimit { cost }
  search(query: $q, type: ISSUE, first: 50) {
    issueCount
    nodes {
      ... on PullRequest {
        number url title isDraft headRefOid baseRefOid headRefName baseRefName isCrossRepository
        author { login avatarUrl ... on User { name } }
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        reviews(last: 100, author: $identity, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes { databaseId state submittedAt commit { oid } }
        }
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
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  number?: number;
  url?: string;
  title?: string;
  isDraft?: boolean;
  headRefOid?: string;
  baseRefOid?: string;
  author?: { login?: string; name?: string; avatarUrl?: string } | null;
  repository?: { nameWithOwner?: string };
  labels?: { nodes?: Array<{ name?: string }> };
  reviews?: { nodes?: SubmittedReview[] };
  timelineItems?: {
    nodes?: Array<{ id?: string; createdAt?: string; actor?: { __typename?: string; login?: string; name?: string; avatarUrl?: string } | null; requestedReviewer?: { __typename?: string; login?: string } | null }>;
  };
}

/** A review submitted by the configured identity, scoped to the commit it reviewed. */
interface SubmittedReview {
  databaseId: number;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  submittedAt: string;
  commit: { oid: string } | null;
}

/** Lifecycle and reviewer evidence for a PR whose request disappeared from search. */
interface ReviewPrSnapshot {
  state: NonNullable<ReviewItem['pr']['state']>;
  headRefOid?: string; baseRefOid?: string; isDraft?: boolean;
  headRefName?: string; baseRefName?: string; isCrossRepository?: boolean;
  reviews?: SearchPr['reviews'];
}

type ReviewPrBatch = Record<string, { pullRequest?: ReviewPrSnapshot | null } | null>;

const SUBMITTED_VERDICTS: Record<SubmittedReview['state'], ReviewVerdict> = {
  APPROVED: 'approve',
  CHANGES_REQUESTED: 'request_changes',
  COMMENTED: 'comment',
};

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
 * The reviews loop: search, file requests by head, withdraw what the
 * search stopped returning. Off (`[reviews].enabled = false`) it makes no
 * call. The search and batched checks of missing PRs share the GitHub budget;
 * they wait while that budget is blocked.
 */
export async function reviewsLoop(
  identity: string,
  token: () => string,
  log: (m: string) => void = () => {},
  opts: { run?: GhGraphql; fetch?: FetchLike; now?: number; wharf?: ReviewWharfOptions; notify?: (event: { key: string; text: string; kind: string; url: string }) => void } = {},
): Promise<void> {
  const cfg = loadConfig();
  reviewAutomationCutoff(cfg.reviews, undefined, opts.now ?? Date.now());
  if (!cfg.reviews.enabled) return;
  const now = opts.now ?? Date.now();
  const gh = { token, ...(opts.fetch ? { fetch: opts.fetch } : {}), now };
  const wharf = Object.values(cfg.grounds).some((g) => g.wharf);
  const w = { ...opts.wharf, now };
  // The search needs the budget; drafting is local and runs either way.
  if (!githubBlockedUntil(now)) {
    const found = await searchReviews(identity, token, log, opts.run ?? runGraphql, now, opts.fetch);
    if (found) await settleGone(found, identity, gh, opts.run ?? runGraphql, log);
  }
  // On wharf grounds, a round is claimed (its document created) before it is drafted.
  if (wharf) await claimReviewDocs(log, w);
  await refreshReviewDrafts(gh, log);
  draftReviews(identity, log, now, undefined, { token, run: opts.run ?? runGraphql });
  if (!githubBlockedUntil(now)) await postOrStage(gh, log);
  await refreshReviewDrafts(gh, log);
  for (const event of refreshReviewNotifications(now)) {
    const port = Number(process.env.LOBSTAH_GLASS_PORT ?? cfg.glass.port);
    const url = `http://127.0.0.1:${port}/${event.hash}`;
    const notice = { key: event.key, text: event.notification.text, kind: event.notification.kind, url };
    if (opts.notify) opts.notify(notice);
    else if (cfg.hooks.notify?.command) {
      const child = spawn(cfg.hooks.notify.command, { shell: true, detached: true, stdio: 'ignore', env: { ...process.env,
        LOBSTAH_ID: event.key, LOBSTAH_KEY: event.key, LOBSTAH_LANE: 'chore', LOBSTAH_VERB: notice.kind,
        LOBSTAH_NOTE: notice.text, LOBSTAH_AT: event.notification.at, LOBSTAH_URL: url, LOBSTAH_GLASS_URL: url, LOBSTAH_PR_URL: url,
      } });
      child.on('error', err => log(`review notify: ${err.message}`)); child.unref();
    }
  }
  if (wharf) {
    await runReviewRequests(log, { ...w, dismiss: (key) => dismissReviewRound(key, 'hosted', gh) });
    await publishReviewDocs(log, w);
  }
}

/**
 * Confirm missing PRs in GraphQL batches before settling their requests.
 * This also repairs cached withdrawn/posted rows when their PR later merges.
 * A failed or incomplete state check leaves unconfirmed rounds untouched.
 */
async function settleGone(found: { seen: Set<string>; inScope: (item: ReviewItem) => boolean }, identity: string, gh: { token: () => string; fetch?: FetchLike; now: number }, run: GhGraphql, log: (m: string) => void): Promise<void> {
  const missing = listReviews().filter((item) => (!found.seen.has(item.key) || latestRound(item)?.staged) && found.inScope(item) &&
    !['merged', 'closed'].includes(latestRound(item)?.state ?? ''));
  const confirmed = new Set<string>();
  for (let start = 0; start < missing.length; start += 50) {
    if (githubBlockedUntil(gh.now)) break;
    const batch = missing.slice(start, start + 50);
    const declarations = ['$identity: String!'];
    const fields: string[] = [];
    const variables: Record<string, unknown> = { identity };
    batch.forEach((item, index) => {
      declarations.push(`$owner${index}: String!`, `$repo${index}: String!`, `$number${index}: Int!`);
      Object.assign(variables, { [`owner${index}`]: item.pr.owner, [`repo${index}`]: item.pr.repo, [`number${index}`]: item.pr.number });
      fields.push(`pr${index}: repository(owner: $owner${index}, name: $repo${index}) { pullRequest(number: $number${index}) {
        state headRefOid baseRefOid isDraft headRefName baseRefName isCrossRepository reviews(last: 100, author: $identity, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes { databaseId state submittedAt commit { oid } }
        }
      } }`);
    });
    const data = reviewQuery<ReviewPrBatch>(
      { query: `query(${declarations.join(', ')}) { rateLimit { cost } ${fields.join('\n')} }`, variables }, gh.token, run, gh.now, log, 'PR state check');
    if (!data) continue;
    for (const [index, item] of batch.entries()) {
      const pr = data[`pr${index}`]?.pullRequest;
      if (!pr || !['OPEN', 'MERGED', 'CLOSED'].includes(pr.state)) continue;
      confirmed.add(item.key);
      const observedPr = {
        ...item.pr, state: pr.state,
        ...(pr.headRefName !== undefined ? { headRefName: pr.headRefName } : {}),
        ...(pr.baseRefName !== undefined ? { baseRefName: pr.baseRefName } : {}),
        ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
      };
      if (JSON.stringify(item.pr) !== JSON.stringify(observedPr)) writeReview({ ...item, pr: observedPr, updatedAt: new Date(gh.now).toISOString() });
      settleSubmittedReview(item, pr.reviews);
      const submitted = [...(pr.reviews?.nodes ?? [])].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1);
      if (pr.state === 'OPEN' && pr.headRefOid && pr.baseRefOid && submitted?.state === 'APPROVED' && submitted.commit?.oid !== pr.headRefOid) {
        const fresh = readReview(item.key)!;
        fresh.pr = { ...fresh.pr, headSha: pr.headRefOid, baseSha: pr.baseRefOid, diffId: undefined, draft: pr.isDraft };
        writeReview(fresh);
        await reapproveBaseUpdate(fresh, identity, { ...gh, log });
      }
    }
  }
  for (const item of listReviews()) {
    const r = latestRound(item);
    if (!confirmed.has(item.key) || !r?.staged || !['drafted', 'stale', 'withdrawn'].includes(r.state) || item.pr.state !== 'OPEN') continue;
    const out = await settleStagedReview(item.key, gh);
    if (out === 'pending' && r.state === 'withdrawn') {
      const fresh = readReview(item.key)!;
      const round = latestRound(fresh)!;
      round.state = round.headSha === fresh.pr.headSha ? 'drafted' : 'stale';
      delete round.reason;
      writeReview(fresh);
    }
    if (out === 'posted') log(`${item.key}: review sent from the review tool`);
    if (out === 'deleted') log(`${item.key}: pending review deleted in the review tool; round dismissed`);
  }
  for (const key of withdrawUnseenReviews(found.seen, (item) => confirmed.has(item.key), gh.now))
    log(`${key}: review request gone; round ${latestRound(readReview(key)!)!.state}`);
}

/** Submitted approvals, change requests, and comments all finish work on their reviewed head. */
function settleSubmittedReview(item: ReviewItem, reviews: SearchPr['reviews']): void {
  const round = latestRound(item);
  if (!round || round.state === 'posted') return;
  const submitted = (reviews?.nodes ?? []).filter((review) => review.commit?.oid === round.headSha &&
    Date.parse(review.submittedAt) >= Date.parse(round.requestedAt))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1);
  if (submitted) markReviewPosted(item.key, round.id, { reviewId: String(submitted.databaseId), by: 'review tool', at: submitted.submittedAt,
    verdict: SUBMITTED_VERDICTS[submitted.state] });
}

/** Refresh an existing draft without inheriting any automatic publishing permission. */
export async function refreshReviewDrafts(gh: { now: number }, log: (message: string) => void = () => {}): Promise<void> {
  for (const item of listReviews()) {
    const round = latestRound(item);
    if (!round || item.mutedAt || ['MERGED', 'CLOSED'].includes(item.pr.state ?? '') ||
        (round.wharf && !round.wharf.mine)) continue;
    const stageFailed = round.state === 'drafted' && round.reason?.startsWith('stage failed');
    const draft = round.state === 'drafted' ? readRoundDraft(item.key, round.id) : undefined;
    const staleDraft = round.state === 'stale' || (draft && !('error' in draft) && !reviewDraftCoversHead(item, round, draft));
    if (!staleDraft && !stageFailed && !(round.refresh && round.state === 'failed')) continue;
    if (round.refresh && gh.now < Date.parse(round.refresh.retryAt)) continue;
    const job = round.dispatch ? verbOf(round.dispatch) : undefined;
    if (job && round.dispatch && dispatchWasCancelled(round.dispatch, job.lane) && round.refresh?.cancelledDispatch !== round.dispatch) {
      delete round.refresh;
      round.state = 'failed';
      round.reason = 'the review job was cancelled';
      writeReview(item);
      continue;
    }
    if (job && job.verb !== 'done' && job.verb !== 'failed' && !cancelQueued(round.dispatch!, job.lane)) {
      round.refresh ??= { attempts: 0, retryAt: new Date(gh.now).toISOString() };
      round.refresh.cancelledDispatch = round.dispatch;
      round.manualPublishOnly = true;
      delete round.notification;
      delete round.needsYou;
      writeReview(item);
      try { if (!dispatchWasCancelled(round.dispatch!, job.lane)) requestCancel(round.dispatch!, job.lane); }
      catch { /* A finishing claimant is rechecked on the next poll. */ }
      continue;
    }
    const attempts = (round.refresh?.attempts ?? 0) + 1;
    const delay = stageFailed || round.state === 'failed' ? Math.min(30_000 * 2 ** Math.min(attempts - 1, 5), 15 * 60_000) : 0;
    const why = await redraftReviewRound(item.key, gh);
    if (why) { log(`${item.key}: draft refresh deferred: ${why}`); continue; }
    const fresh = readReview(item.key)!;
    const next = latestRound(fresh)!;
    Object.assign(next, { refresh: { attempts, retryAt: new Date(gh.now + delay).toISOString() },
      manualPublishOnly: true, localRequest: true, draftOnly: true, publish: false,
      autoPostApprove: 'ask', autoPostRequestChanges: 'ask' });
    delete next.byHand;
    delete next.reReview;
    writeReview(fresh);
    log(`${item.key}: refreshing the pending draft (attempt ${attempts})`);
  }
}

/**
 * A fresh draft is staged pending or published with its verdict according to
 * the repo policy and the job's publishing receipt. Repairs only stage pending drafts.
 */
async function postOrStage(gh: { token: () => string; fetch?: FetchLike; now: number }, log: (m: string) => void): Promise<void> {
  for (const item of listReviews()) {
    if (item.mutedAt) continue;
    const r = latestRound(item);
    if (r?.state !== 'drafted' || r.reason?.startsWith('post failed') || r.reason?.startsWith('stage failed')) continue;
    const draft = readRoundDraft(item.key, r.id);
    if ('error' in draft) continue;
    if (r.verdict !== draft.verdict || JSON.stringify(r.blocking) !== JSON.stringify(draft.blocking) || JSON.stringify(r.decisions) !== JSON.stringify(draft.decisions)) {
      r.verdict = draft.verdict; r.blocking = draft.blocking; r.decisions = draft.decisions;
      r.decisionAnswers = carryReviewDecisionAnswers(draft.decisions, r.decisionAnswers);
      writeReview(item);
    }
    if (unansweredReviewDecisions(r).length) continue;
    const publish = reviewCanPublish(loadConfig().reviews, item.pr.repoKey, r, draft.verdict);
    if (publish) {
      const out = await postReview(item.key, { by: 'auto', ...gh });
      log(out.posted ? `${item.key}: review published (${out.reviewId})${out.unresolved ? `; ${out.unresolved.length} thread(s) not resolved: ${out.unresolved.map(thread => `${thread.url} (${thread.why})`).join('; ')}` : ''}` : `${item.key}: not published: ${out.why}`);
    } else if (!r.staged) {
      const out = await stageReview(item.key, gh);
      log(out.staged ? `${item.key}: draft staged as your pending review (${out.reviewId})` : `${item.key}: not staged: ${out.why}`);
    }
  }
}

/** Apply the shared GitHub budget and reject partial GraphQL responses before changing rounds. */
function reviewQuery<T>(request: { query: string; variables: Record<string, unknown> }, token: () => string, run: GhGraphql, now: number,
  log: (m: string) => void, operation: string): T | undefined {
  const res = run(request, token());
  const { headers, body } = splitGitHubResponse(res.stdout);
  let answer: { data?: T & { rateLimit?: { cost?: number } }; errors?: Array<{ message: string }> } = {};
  try {
    answer = JSON.parse(body);
  } catch {
    /* failure recorded below */
  }
  const reason =
    res.error?.message ?? answer.errors?.map((e) => e.message).join('; ') ?? firstMeaningfulLine(res.stderr) ?? `gh exited ${res.status}`;
  const limited = classifyGhError(reason).kind === 'rate-limit' || headers['x-ratelimit-remaining'] === '0';
  recordGitHubResponse(headers, { now, cost: answer.data?.rateLimit?.cost, success: res.status === 0 && !limited && !!answer.data && !answer.errors?.length });
  if (limited) {
    const retry = Number(headers['retry-after']);
    recordGitHubRateLimit(now, Number.isFinite(retry) && retry > 0 ? now + retry * 1000 : undefined);
    log('reviews: GitHub rate limit reached; the search waits for the budget');
    return undefined;
  }
  if (res.status !== 0 || !answer.data || answer.errors?.length) {
    log(`reviews: ${operation} failed: ${reason}`);
    return undefined;
  }
  return answer.data;
}

interface ReviewConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface ThreadComment { author: { login: string } | null; body: string; url: string }
interface GitHubReviewThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewConnection<ThreadComment>;
}
interface ReviewThreadsResponse { repository?: { pullRequest?: { reviewThreads: ReviewConnection<GitHubReviewThread> } } }

/** Fetch every unresolved inline thread and every reply; never present partial results as complete. */
export function readOpenReviewThreads(item: ReviewItem, token: () => string, run: GhGraphql, now: number,
  log: (message: string) => void): ReviewThread[] | undefined {
  const threads: ReviewThread[] = [];
  const commentFields = 'pageInfo { hasNextPage endCursor } nodes { author { login } body url }';
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    if (githubBlockedUntil(now)) return undefined;
    const data: ReviewThreadsResponse | undefined = reviewQuery<ReviewThreadsResponse>({
      query: `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) { rateLimit { cost } repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id path line isResolved isOutdated comments(first: 100) { ${commentFields} } } }
      } } }`,
      variables: { owner: item.pr.owner, repo: item.pr.repo, number: item.pr.number, cursor },
    }, token, run, now, log, 'review threads');
    const page: ReviewConnection<GitHubReviewThread> | undefined = data?.repository?.pullRequest?.reviewThreads;
    if (!page?.pageInfo || !Array.isArray(page.nodes)) return undefined;
    for (const thread of page.nodes) {
      if (thread.isResolved) continue;
      let comments = thread.comments;
      const replies: ThreadComment[] = [];
      const replyCursors = new Set<string>();
      while (comments?.pageInfo && Array.isArray(comments.nodes)) {
        replies.push(...comments.nodes);
        if (!comments.pageInfo.hasNextPage) break;
        const after = comments.pageInfo.endCursor;
        if (!after || replyCursors.has(after) || githubBlockedUntil(now)) return undefined;
        replyCursors.add(after);
        const next = reviewQuery<{ node?: { comments: ReviewConnection<ThreadComment> } }>({
          query: `query($id: ID!, $cursor: String!) { rateLimit { cost } node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${commentFields} } } } }`,
          variables: { id: thread.id, cursor: after },
        }, token, run, now, log, 'review replies');
        if (!next?.node?.comments) return undefined;
        comments = next.node.comments;
      }
      if (!comments?.pageInfo || !Array.isArray(comments.nodes)) return undefined;
      threads.push({ id: thread.id, path: thread.path, line: thread.line, isOutdated: thread.isOutdated,
        comments: replies.map(comment => ({ author: comment.author?.login ?? 'deleted user', body: comment.body, url: comment.url })) });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    cursor = page.pageInfo.endCursor;
    if (!cursor || visited.has(cursor)) return undefined;
    visited.add(cursor);
  } while (cursor);
  return undefined;
}

async function searchReviews(identity: string, token: () => string, log: (m: string) => void, run: GhGraphql, now: number, fetch?: FetchLike): Promise<{ seen: Set<string>; inScope: (item: ReviewItem) => boolean } | undefined> {
  const rc = loadConfig().reviews;
  const answer = reviewQuery<{ search?: { issueCount?: number; nodes?: SearchPr[] } }>(
    { query: REVIEW_SEARCH, variables: { q: reviewSearchQuery(identity), identity } }, token, run, now, log, 'search');
  const search = answer?.search;
  if (!search) return undefined;

  const repos = configuredRepos();
  const inScope = (nwo: string): boolean => rc.repos === 'any' || repos.has(nwo.toLowerCase());
  const me = identity.toLowerCase();
  const seen = new Set<string>();
  const nodes = search.nodes ?? [];
  for (const pr of nodes) {
    const nwo = pr.repository?.nameWithOwner;
    const [owner, repo] = nwo?.split('/') ?? [];
    if (!nwo || !owner || !repo || !pr.number || !pr.url || !pr.headRefOid || !inScope(nwo)) continue;
    const requests = (pr.timelineItems?.nodes ?? [])
      .filter((e) => e.id && e.createdAt && e.requestedReviewer?.__typename === 'User' && e.requestedReviewer.login?.toLowerCase() === me)
      .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
    const request = requests.at(-1);
    if (!request) continue; // a team request only
    const humanRequester = requests.filter((event) => event.actor?.login && !isReviewBot(event.actor.login, event.actor.__typename)).at(-1)?.actor;
    const repoKey = repos.get(nwo.toLowerCase());
    const author = pr.author?.login ?? '';
    const labels = (pr.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean);
    const settings = reviewSettings(rc, repoKey);
    const skipLabel = labels.find((l) => settings.skipLabels.includes(l));
    const skip = settings.skipAuthors.includes(author) ? `skipped: author ${author} is in skipAuthors` : skipLabel ? `skipped: label ${skipLabel} is in skipLabels` : undefined;
    const prior = readReview(reviewKey(owner, repo, pr.number));
    const round = prior && latestRound(prior);
    let previousDiffId = currentReviewDiffId(round?.diffId);
    let diffId = prior?.pr.headSha === pr.headRefOid && prior.pr.baseSha === pr.baseRefOid ? currentReviewDiffId(prior.pr.diffId) : undefined;
    if (!prior?.mutedAt && pr.baseRefOid) {
      if (round && round.headSha !== pr.headRefOid)
        previousDiffId ??= await reviewDiffId(nwo, round.baseSha ?? pr.baseRefOid, round.headSha, { token, fetch, now, log });
      diffId ??= await reviewDiffId(nwo, pr.baseRefOid, pr.headRefOid, { token, fetch, now, log });
      if (round?.headSha === pr.headRefOid) previousDiffId ??= diffId;
    }
    const submitted = [...(pr.reviews?.nodes ?? [])].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1);
    // Absorbed stacked changes can leave the patch fingerprint smaller.
    // Keep the round if Git proves those changes now come from the base.
    if (prior && round && repoKey && settings.autoReapproveBaseOnly && pr.baseRefOid && diffId && previousDiffId && previousDiffId !== diffId &&
        submitted?.state === 'APPROVED' && submitted.commit?.oid === round.headSha && Object.values(loadConfig().grounds).some(g => g.repos.includes(repoKey)) &&
        await verifiedBaseUpdate({ ...prior, pr: { ...prior.pr, headSha: pr.headRefOid, baseSha: pr.baseRefOid } }, round.headSha, token()))
      previousDiffId = diffId;
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
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          isCrossRepository: pr.isCrossRepository,
          headSha: pr.headRefOid,
          ...(pr.baseRefOid ? { baseSha: pr.baseRefOid } : {}),
          ...(diffId ? { diffId } : {}),
          state: 'OPEN',
          ...(labels.length ? { labels } : {}),
          ...(pr.isDraft ? { draft: true } : {}),
          ...(repoKey ? { repoKey } : {}),
        },
        round: {
          id: request.id!, requestedAt: request.createdAt!,
          ...(request.actor?.login ? { requestedBy: request.actor.login } : {}),
          ...(request.actor?.name ? { requestedByName: request.actor.name } : {}),
          ...(request.actor?.avatarUrl ? { requestedByAvatarUrl: request.actor.avatarUrl } : {}),
          requestedAutomatically: isReviewBot(request.actor?.login, request.actor?.__typename),
          ...(humanRequester?.login ? { humanRequester: { login: humanRequester.login, name: humanRequester.name, avatarUrl: humanRequester.avatarUrl } } : {}),
        },
        ...(skip ? { skip } : {}),
        ...(previousDiffId && round ? { previousDiff: { headSha: round.headSha, diffId: previousDiffId } } : {}),
      },
      now,
    );
    seen.add(item.key);
    settleSubmittedReview(item, pr.reviews);
    if (latestRound(readReview(item.key)!)?.reReview || (submitted?.commit?.oid && submitted.commit.oid !== item.pr.headSha))
      await reapproveBaseUpdate(readReview(item.key)!, identity, { token, fetch, now, log });
    if (opened) log(`${item.key}: review requested by ${reviewAsker(item, latestRound(item)!).login}${skip ? ` (${skip})` : ''}`);
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

/**
 * Why a requested round gets no job, or undefined when it gets one. The
 * daily cap bounds only the reviews lobstah starts on its own: one a person
 * asks for (`byHand`: a Draft click, a redraft) always starts, and counts
 * toward the day's total like any other.
 */
function noJob(item: ReviewItem, round: ReviewRound, started: number, byHand: boolean): string | undefined {
  const rc = loadConfig().reviews;
  if (round.reason?.startsWith('skipped:')) return round.reason;
  if (!item.pr.repoKey) return 'no job: not a configured repo, so there is no checkout to review in';
  if (!byHand && started >= rc.maxPerDay)
    return `no job: the daily cap on automatic reviews ([reviews].maxPerDay = ${rc.maxPerDay}) is reached, so this one wasn't started. Start it by hand with Draft on the glass's Reviews tab.`;
  return undefined;
}

/**
 * Drafting, local and request-free: start a job for each requested round
 * that should have one, finish rounds whose job ended, hand a trap job to
 * the daemon when its trap wait expires, and cancel the job of a round the
 * request no longer stands for.
 */
export function draftReviews(identity: string, log: (m: string) => void = () => {}, now = Date.now(), manualKey?: string,
  github?: { token: () => string; run: GhGraphql }): void {
  const cfg = loadConfig();
  const items = listReviews();
  const scopes = backendScopes(cfg);
  let started = startedToday(items, now);
  for (const item of items) {
    if (item.mutedAt) continue;
    if (manualKey && item.key !== manualKey) continue;
    const r = latestRound(item);
    if (!r) continue;
    // A round a person asked for (this Draft click, or a redraft) starts as a Draft click does, past the daily cap and in any mode.
    const manual = manualKey !== undefined || r.byHand === true;
    const repairing = r.refresh !== undefined;
    const settings = reviewSettings(cfg.reviews, item.pr.repoKey, manual || repairing);
    const save = () => writeReview({ ...item, updatedAt: new Date(now).toISOString() });

    // Stop work the person already submitted, withdrew, or dismissed; remove its checkout once the job ends.
    for (const old of item.rounds) {
      if ((!['withdrawn', 'dismissed', 'merged', 'closed'].includes(old.state) && old.state !== 'posted' && !(old.state === 'failed' && old.reason === 'the review job was cancelled')) || !old.dispatch) continue;
      const oldJob = verbOf(old.dispatch);
      if (oldJob && oldJob.verb !== 'done' && oldJob.verb !== 'failed') {
        try {
          if (!cancelQueued(old.dispatch, oldJob.lane)) requestCancel(old.dispatch, oldJob.lane);
          log(`${item.key}: round ${old.state}; cancelled the review job ${old.dispatch}`);
        } catch {
          // still queued or already gone
        }
      } else removeReviewCheckout(item, old, log);
    }

    if (r.state === 'requested' && !r.dispatch) {
      if (r.refresh && now < Date.parse(r.refresh.retryAt)) continue;
      if (!manual && r.changesObservedAt && now - Date.parse(r.changesObservedAt) < 30_000) continue;
      // On wharf grounds, only the boat whose document it is drafts the round, once the document exists.
      if (reviewScope(item, scopes) && !r.wharf?.mine) continue;
      const cutoff = reviewAutomationCutoff(cfg.reviews, item.pr.repoKey, now);
      const oldRequest = !manual && !repairing && settings.work !== 'off' && Date.parse(r.requestedAt) < Date.parse(cutoff);
      const why = oldRequest ? `no job: requested before ${cutoff}; start a draft from Reviews` : settings.work === 'off' ? undefined : noJob(item, r, started, manual || repairing);
      if (settings.work === 'off' || why) {
        if (why && r.reason !== why) {
          r.reason = why;
          save();
        }
        continue;
      }
      if (github && (item.rounds.length > 1 || r.previousReviews?.length))
        r.openThreads = readOpenReviewThreads(item, github.token, github.run, now, log);
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
          sessionMode: 'fresh',
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
      r.onDemand = manual;
      delete r.byHand;
      r.publish = repairing ? false : settings.publish;
      r.draftOnly = repairing || !settings.publish;
      r.autoPostApprove = repairing ? 'ask' : settings.autoPostApprove;
      r.autoPostRequestChanges = repairing ? 'ask' : settings.autoPostRequestChanges;
      delete r.reason;
      save();
      started++;
      log(`${item.key}: drafting the review as ${id}${trap ? ' (a free trap first)' : ''}`);
      continue;
    }

    const job = r.dispatch ? verbOf(r.dispatch) : undefined;
    if (r.dispatch && ['drafting', 'drafted', 'stale'].includes(r.state) && job && dispatchWasCancelled(r.dispatch, job.lane)) {
      Object.assign(r, { state: 'failed', reason: 'the review job was cancelled' });
      save();
      // The claimant may still be winding down; keep its checkout until the job ends.
      if (job.verb === 'done' || job.verb === 'failed') removeReviewCheckout(item, r, log);
      continue;
    }
    if (!r.dispatch || r.state !== 'drafting') continue;
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
      Object.assign(r, { verdict: draft.verdict, blocking: draft.blocking, state: 'drafted', draftedAt: job.at ?? new Date(now).toISOString() });
      r.decisions = draft.decisions;
      r.decisionAnswers = carryReviewDecisionAnswers(draft.decisions, r.decisionAnswers);
      if (unansweredReviewDecisions(r).length) delete r.refresh;
      delete r.reason;
      // The head moved while the job ran: the draft reviews an older head.
      if (!reviewDraftCoversHead(item, r, draft)) Object.assign(r, { state: 'stale', reason: `the head moved to ${item.pr.headSha.slice(0, 7)} while the review was drafted` });
    }
    save();
    removeReviewCheckout(item, r, log);
    log(`${item.key}: review ${r.state}`);
  }
}

/** Start one requested, stale, or failed round according to its repo policy. */
export async function draftReviewOnDemand(key: string, now = Date.now()): Promise<string | undefined> {
  const item = readReview(key);
  const round = item && latestRound(item);
  if (!item || !round) return `no review item ${key}`;
  if (reviewSettings(loadConfig().reviews, item.pr.repoKey).mode === 'notify' && round.state === 'requested') return 'reviews are in notify mode; switch to on-demand or an automatic mode to review';
  if (!['requested', 'stale', 'failed'].includes(round.state) || (round.state === 'requested' && round.dispatch)) return `${key}: this round is already ${round.state}`;
  const why = noJob(item, round, startedToday(listReviews(), now), true);
  if (why) return why;
  const identity = loadPickupConfig().reviews?.identity;
  if (!identity) return 'reviews are not enabled; run lobstah setup reviews';
  if (round.state !== 'requested') {
    const why = await redraftReviewRound(key, { now });
    if (why) return why;
  }
  acknowledgeReview(key, now);
  draftReviews(identity, () => {}, now, key, { token: loadPickupConfig().reviews!.token, run: runGraphql });
  return latestRound(readReview(key)!)?.state === 'drafting' ? undefined : 'the round could not start drafting';
}

/** A new local request follows the repo mode and daily cap, just like discovery. */
export function requestNewReview(key: string, now = Date.now(), run: GhGraphql = runGraphql): string | undefined {
  const item = readReview(key);
  if (!item || latestRound(item)?.state !== 'dismissed') return 'Only a skipped or dismissed review can start a new round.';
  const config = loadPickupConfig().reviews;
  if (!config) return 'Reviews are not enabled. Run lobstah setup reviews.';
  if (githubBlockedUntil(now)) return 'GitHub is temporarily unavailable. Try again when the review can be refreshed.';
  const data = reviewQuery<{ repository?: { pullRequest?: { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string } } }>(
    { query: 'query($owner: String!, $repo: String!, $number: Int!) { rateLimit { cost } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state headRefOid } } }',
      variables: { owner: item.pr.owner, repo: item.pr.repo, number: item.pr.number } }, config.token, run, now, () => {}, 'new review head check');
  const current = data?.repository?.pullRequest;
  if (!current?.headRefOid || current.state !== 'OPEN') return current ? 'This PR is closed. Reopen it before requesting a new review.' : 'The current PR head could not be read. Try again.';
  if (item.pr.headSha !== current.headRefOid) delete item.pr.diffId;
  item.pr.headSha = current.headRefOid;
  item.pr.state = current.state;
  writeReview({ ...item, updatedAt: new Date(now).toISOString() });
  const result = newReviewRound(key, now);
  if (typeof result === 'string') return result;
  draftReviews(config.identity, () => {}, now, undefined, { token: config.token, run });
  return undefined;
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
