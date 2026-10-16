import { spawnSync } from 'node:child_process';
import {
  classifyGhError,
  firstMeaningfulLine,
  githubBlockedUntil,
  loadConfig,
  observeReviewRequest,
  recordGitHubRateLimit,
  recordGitHubResponse,
  reviewSettings,
  splitGitHubResponse,
  withdrawUnseenReviews,
} from '@lobstah/core';
import type { ReviewItem } from '@lobstah/core';
import { githubRepoFromOrigin } from '../config.js';

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
        author { login }
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
          nodes { ... on ReviewRequestedEvent { id createdAt actor { login } requestedReviewer { __typename ... on User { login } } } }
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
  author?: { login?: string } | null;
  repository?: { nameWithOwner?: string };
  labels?: { nodes?: Array<{ name?: string }> };
  timelineItems?: {
    nodes?: Array<{ id?: string; createdAt?: string; actor?: { login?: string } | null; requestedReviewer?: { __typename?: string; login?: string } | null }>;
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
  opts: { run?: GhGraphql; now?: number } = {},
): Promise<void> {
  const cfg = loadConfig();
  const rc = cfg.reviews;
  if (!rc.enabled) return;
  const now = opts.now ?? Date.now();
  if (githubBlockedUntil(now)) return;
  const res = (opts.run ?? runGraphql)({ query: REVIEW_SEARCH, variables: { q: reviewSearchQuery(identity) } }, token());
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
    return;
  }
  if (res.status !== 0 || !search) {
    log(`reviews: search failed: ${reason}`);
    return;
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
          headSha: pr.headRefOid,
          ...(labels.length ? { labels } : {}),
          ...(pr.isDraft ? { draft: true } : {}),
          ...(repoKey ? { repoKey } : {}),
        },
        round: { id: request.id!, requestedAt: request.createdAt!, ...(request.actor?.login ? { requestedBy: request.actor.login } : {}) },
        ...(skip ? { skip } : {}),
      },
      now,
    );
    seen.add(item.key);
    if (opened) log(`${item.key}: review requested${request.actor?.login ? ` by ${request.actor.login}` : ''}${skip ? ` (${skip})` : ''}`);
  }
  // A truncated search cannot say a request is gone.
  if ((search.issueCount ?? nodes.length) > nodes.length) return;
  const scoped = (item: ReviewItem): boolean => inScope(`${item.pr.owner}/${item.pr.repo}`);
  for (const key of withdrawUnseenReviews(seen, scoped, now)) log(`${key}: review request gone; round withdrawn`);
}

