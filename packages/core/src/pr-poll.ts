import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { uniqueTempPath, lobstahHome } from './paths.js';
import { parsePrRef, ghPrViewDirect } from './pr.js';
import type { GhPrView, PrRef } from './pr.js';
import { readPr } from './prs.js';
import { clearWatchRateLimitFailures, listWatches, removeWatch, watchDue } from './watch.js';
import type { Watch } from './watch.js';
import { classifyGhError, firstMeaningfulLine } from './gh-errors.js';
import {
  githubBlockedUntil,
  githubPollIntervalSecs,
  recordGitHubRateLimit,
  recordGitHubResponse,
  splitGitHubResponse,
} from './github-budget.js';

interface Connection<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean; endCursor?: string };
}
interface Snapshot extends Omit<GhPrView, 'reviews'> {
  number: number;
  url: string;
  reviews?: Connection<NonNullable<GhPrView['reviews']>[number]>;
  comments?: Connection<{ id: string; updatedAt: string }>;
  reviewThreads?: Connection<{ isResolved: boolean }>;
  commits?: Connection<{ commit: { statusCheckRollup?: { contexts?: Connection<NonNullable<GhPrView['statusCheckRollup']>[number]> } } }>;
}
interface Cached {
  fingerprint: string;
  view: GhPrView;
  at: number;
  error?: string;
}
interface Cycle {
  at: number;
  nextAt: number;
  snapshots: Record<string, Cached>;
  links: Record<string, Snapshot[]>;
  error?: string;
}
const cycleFile = (repo: string) => path.join(lobstahHome(), 'pr-polls', `${repo.replace(/[^\w.-]/g, '_')}.json`);
const readCycle = (repo: string): Cycle | undefined => {
  try {
    return JSON.parse(fs.readFileSync(cycleFile(repo), 'utf8'));
  } catch {
    return undefined;
  }
};
const repoOf = (ref: PrRef) => `${ref.owner}/${ref.repo}`;
export const isPrPresetWatch = (w: Watch): boolean => !!parsePrRef(w.key) && /\bwatch check-pr\s/.test(w.check);
export const prBatchInFlight = (key: string): boolean => {
  const ref = parsePrRef(key);
  return !!ref && fs.existsSync(`${cycleFile(repoOf(ref))}.lock`);
};

/** Only pollers use this cache: a manual check-pr retains its immediate-read semantics. */
export function cachedPrView(ref: PrRef): GhPrView | undefined {
  if (process.env.LOBSTAH_PR_BATCH !== '1') return undefined;
  const blocked = githubBlockedUntil();
  if (blocked) throw new Error(`GitHub rate limit reached; retry after ${new Date(blocked).toISOString()}`);
  const cycle = readCycle(repoOf(ref));
  if (!cycle) return undefined;
  if (cycle.error) throw new Error(cycle.error);
  const cached = cycle.snapshots[ref.key];
  if (cached?.error) throw new Error(cached.error);
  return cached ? { ...cached.view, fetchedAt: new Date(cached.at).toISOString() } : undefined;
}

const fields = `number url title state isDraft isCrossRepository headRefOid baseRefName baseRefOid headRefName mergeStateStatus reviewDecision mergedAt closedAt updatedAt
  reviews(last:100){nodes{author{login} state submittedAt} pageInfo{hasPreviousPage endCursor}}
  comments(last:1){nodes{id updatedAt} pageInfo{endCursor}}
  reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage endCursor}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{app{name slug} workflowRun{workflow{name}}}}
    ... on StatusContext{context state targetUrl createdAt}} pageInfo{hasNextPage endCursor}}}}}}`;

/** One repository query, including branch links (negative links otherwise cost one gh pr list each cycle). */
export function prBatchQuery(refs: PrRef[]): { query: string; links: Array<{ alias: string; key: string }> } {
  const links: Array<{ alias: string; key: string }> = [];
  const branches = new Set<string>();
  for (const ref of refs) {
    const p = readPr(ref.key);
    for (const [direction, branch] of [
      ['head', p?.baseRefName],
      ['base', p?.headRefName],
    ] as const) {
      if (branch) branches.add(`${direction}\0${branch}`);
    }
  }
  const linkFields = [...branches].map((entry, i) => {
    const [direction, branch] = entry.split('\0') as [string, string];
    const alias = `link${i}`;
    links.push({ alias, key: `${repoOf(refs[0]!)}:${direction}:${branch}` });
    return `${alias}:pullRequests(${direction === 'head' ? 'headRefName' : 'baseRefName'}:${JSON.stringify(branch)},states:OPEN,first:3){nodes{${fields}}}`;
  });
  return {
    query: `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${refs.map((r) => `pr${r.number}:pullRequest(number:${r.number}){${fields}}`).join('\n')}
    ${linkFields.join('\n')}} rateLimit{cost}}`,
    links,
  };
}

function toView(s: Snapshot): GhPrView {
  const contexts = s.commits?.nodes?.[0]?.commit.statusCheckRollup?.contexts;
  const view: GhPrView = {
    ...s,
    reviews: s.reviews?.nodes ?? [],
    statusCheckRollup: contexts?.nodes ?? [],
    unresolvedThreads: s.reviewThreads?.nodes?.filter((t) => !t.isResolved).length,
  };
  // Match gh's flattened rollup shape so checks with the same name but different apps stay distinct.
  view.statusCheckRollup = view.statusCheckRollup?.map((c) => {
    const suite = (c as typeof c & { checkSuite?: { app?: typeof c.app; workflowRun?: { workflow?: { name?: string } } } }).checkSuite;
    return {
      ...c,
      ...(suite?.app ? { app: suite.app } : {}),
      ...(suite?.workflowRun?.workflow?.name ? { workflowName: suite.workflowRun.workflow.name } : {}),
    };
  });
  return view;
}

export type PrBatchRun = (query: string, ref: PrRef) => { status: number | null; stdout: string; stderr?: string; error?: Error };
const runBatch: PrBatchRun = (query, ref) =>
  spawnSync('gh', ['api', 'graphql', '--include', '--input', '-'], {
    input: JSON.stringify({ query, variables: { owner: ref.owner, repo: ref.repo } }),
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

/** Retire terminal records on the first pass after daemon restart; no network or duplicate notice. */
export function retireTerminalPrWatches(): string[] {
  const retired: string[] = [];
  for (const w of listWatches()) {
    const state = parsePrRef(w.key) && readPr(w.key)?.state;
    if (state === 'MERGED' || state === 'CLOSED') {
      removeWatch(w.key);
      retired.push(w.key);
    }
  }
  return retired;
}

/** Shared by daemon, pick and helm wait. Atomic per-repo claim prevents simultaneous duplicate batches. */
export function preparePrWatchBatch(
  defaultEverySecs: number,
  now = Date.now(),
  opts: { run?: PrBatchRun; detail?: (ref: PrRef) => GhPrView } = {},
): void {
  clearWatchRateLimitFailures();
  retireTerminalPrWatches();
  const groups = new Map<string, PrRef[]>(),
    due = new Set<string>(),
    dueRefs = new Set<string>();
  for (const w of listWatches()) {
    if (!isPrPresetWatch(w) || w.done) continue;
    const ref = parsePrRef(w.key)!;
    const refs = groups.get(repoOf(ref)) ?? [];
    refs.push(ref);
    groups.set(repoOf(ref), refs);
    if (watchDue(w, defaultEverySecs, now)) {
      due.add(repoOf(ref));
      dueRefs.add(ref.key);
    }
  }
  fs.mkdirSync(path.join(lobstahHome(), 'pr-polls'), { recursive: true });
  for (const [repo, refs] of groups) {
    if (!due.has(repo)) continue;
    const file = cycleFile(repo),
      lock = `${file}.lock`;
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A crashed batch is retried, never a permanently claimed cycle.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
      } catch {
        /* raced */
      }
      continue;
    }
    try {
      const before = readCycle(repo);
      if (before && now < before.nextAt) continue;
      const blocked = githubBlockedUntil(now);
      if (blocked) continue;
      const { query, links } = prBatchQuery(refs);
      const res = (opts.run ?? runBatch)(query, refs[0]!);
      const fetchedAt = Date.now();
      const { headers, body } = splitGitHubResponse(res.stdout);
      let answer: {
        data?: { repository?: Record<string, Snapshot | Connection<Snapshot> | null>; rateLimit?: { cost?: number } };
        errors?: Array<{ message: string; path?: Array<string | number> }>;
      } = {};
      try {
        answer = JSON.parse(body);
      } catch {
        /* failure recorded below */
      }
      const reason =
        res.error?.message ??
        answer.errors?.map((e) => e.message).join('; ') ??
        firstMeaningfulLine(res.stderr) ??
        `gh exited ${res.status}`;
      const limited = classifyGhError(reason).kind === 'rate-limit' || headers['x-ratelimit-remaining'] === '0';
      recordGitHubResponse(headers, {
        now,
        cost: answer.data?.rateLimit?.cost,
        success: res.status === 0 && !limited && !!answer.data?.repository,
      });
      if (limited) {
        const retry = Number(headers['retry-after']);
        recordGitHubRateLimit(now, Number.isFinite(retry) && retry > 0 ? now + retry * 1000 : undefined);
      }
      const cycle: Cycle = {
        at: fetchedAt,
        nextAt: now + githubPollIntervalSecs(defaultEverySecs, now, groups.size) * 1000,
        snapshots: {},
        links: {},
      };
      const repository = answer.data?.repository;
      if (res.error || !repository) cycle.error = reason || 'GitHub returned no repository';
      if (limited)
        cycle.error = `GitHub rate limit reached; retry after ${new Date(githubBlockedUntil(now) ?? cycle.nextAt).toISOString()}`;
      if (!cycle.error && repository) {
        for (const ref of refs) {
          const raw = repository[`pr${ref.number}`] as Snapshot | null;
          if (!raw?.state || !raw.headRefOid) {
            cycle.snapshots[ref.key] = {
              fingerprint: '',
              view: before?.snapshots[ref.key]?.view ?? ({} as GhPrView),
              at: fetchedAt,
              error:
                answer.errors?.find((e) => e.path?.includes(`pr${ref.number}`))?.message ??
                `could not resolve to a PullRequest (${ref.key})`,
            };
            continue;
          }
          const fingerprint = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
          const previous = before?.snapshots[ref.key];
          const incomplete =
            raw.reviews?.pageInfo?.hasPreviousPage ||
            raw.reviewThreads?.pageInfo?.hasNextPage ||
            raw.commits?.nodes?.[0]?.commit.statusCheckRollup?.contexts?.pageInfo?.hasNextPage ||
            answer.errors?.some((e) => e.path?.includes(`pr${ref.number}`));
          // Every complete snapshot was just read, regardless of this watch's
          // own cadence. Otherwise another feeder can stamp lastCheckedAt just
          // before every batch and keep its previous view alive forever.
          // Backoff only defers EXTRA detail reads, never the free batch data.
          if (incomplete && previous && !dueRefs.has(ref.key) && (fingerprint !== previous.fingerprint || previous.error)) {
            cycle.snapshots[ref.key] = {
              fingerprint,
              view: toView(raw),
              at: fetchedAt,
              error: previous.error ?? `Incomplete PR batch for ${ref.key}; details deferred until the watch is due`,
            };
            continue;
          }
          try {
            const view =
              fingerprint === previous?.fingerprint && !previous.error
                ? previous.view
                : incomplete
                  ? (opts.detail ?? ghPrViewDirect)(ref)
                  : toView(raw);
            cycle.snapshots[ref.key] = { fingerprint, view, at: fetchedAt };
          } catch (e) {
            cycle.snapshots[ref.key] = { fingerprint, view: previous?.view ?? toView(raw), at: fetchedAt, error: (e as Error).message };
            if (classifyGhError((e as Error).message).kind === 'rate-limit') {
              recordGitHubRateLimit(now);
              break;
            }
          }
        }
        for (const link of links) cycle.links[link.key] = (repository[link.alias] as Connection<Snapshot>)?.nodes ?? [];
      }
      const tmp = uniqueTempPath(file);
      fs.writeFileSync(tmp, JSON.stringify(cycle));
      fs.renameSync(tmp, file);
      if (limited) break; // one shared failure, never hammer the next repository
    } finally {
      fs.rmdirSync(lock);
    }
  }
}

/** Branch links already in this cycle cost no extra API requests, including negative answers. */
export function cachedPrStackLink(
  ref: PrRef,
  branch: string,
  direction: 'head' | 'base',
): Array<GhPrView & { number: number; url: string }> | undefined {
  if (process.env.LOBSTAH_PR_BATCH !== '1') return undefined;
  const c = readCycle(repoOf(ref));
  if (!c || c.error) return undefined;
  const rows = c.links[`${repoOf(ref)}:${direction}:${branch}`];
  return rows?.map((r) => ({ ...toView(r), fetchedAt: new Date(c.at).toISOString(), number: r.number, url: r.url }));
}
