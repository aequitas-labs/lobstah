import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  enqueue,
  loadConfig,
  parsePrRef,
  postNotice,
  prMergeStep,
  readPr,
  readPrs,
  readWatch,
  withPrLock,
  writePr,
  type Config,
  type PrMergeMethod,
  type PrMergeRequest,
  type PrRecord,
} from '@lobstah/core';
import { githubRepoFromOrigin, loadPickupConfig } from '@lobstah/pick';
import { githubViewer, mayAutoWatch, prAuthorship } from './pr-ownership.js';
import { addPrWatch } from './pr-watch.js';

/** A merge request the boat refuses, with the HTTP status the glass answers. */
export class PrMergeRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The configured repo whose origin is this forge repo (`owner/repo`), if any. */
export function repoKeyForForge(cfg: Pick<Config, 'repos'>, forgeRepo: string): string | undefined {
  const want = forgeRepo.toLowerCase();
  return Object.entries(cfg.repos).find(([, r]) => r.origin && githubRepoFromOrigin(r.origin)?.toLowerCase() === want)?.[0];
}

/**
 * How a PR in this forge repo merges: its repo's `[repos.<key>].mergeMethod`,
 * else the `[pickup.github]` merge method, else squash.
 */
export function prMergeMethod(cfg: Pick<Config, 'repos'>, forgeRepo: string, pickup: () => PrMergeMethod | undefined = pickupMergeMethod): PrMergeMethod {
  const key = repoKeyForForge(cfg, forgeRepo);
  return (key && cfg.repos[key]?.mergeMethod) || pickup() || 'squash';
}

/** pick's method, read at most once a minute: loading pick's config resolves its token, and the glass asks per PR. */
let pickupCache: { at: number; method: PrMergeMethod | undefined } | undefined;
function pickupMergeMethod(now = Date.now()): PrMergeMethod | undefined {
  if (pickupCache && now - pickupCache.at < 60_000) return pickupCache.method;
  let method: PrMergeMethod | undefined;
  try {
    const found = loadPickupConfig().github[0]?.merge.method;
    method = found === 'merge' || found === 'squash' || found === 'rebase' ? found : undefined;
  } catch {
    // No pickup section, or one pick can't load: the default stands.
  }
  pickupCache = { at: now, method };
  return method;
}

/**
 * Ask the boat to merge a PR once it's green (`pr-merge`). Only the person's
 * own PRs: authored by the login gh signs in as, or opened by a dispatch and
 * not known to be someone else's. The request stands until the PR merges,
 * closes, or `cancelPrMerge`.
 */
export function requestPrMerge(key: string, by: string, opts: { viewer?: () => string | undefined; now?: number; cfg?: Config } = {}): PrMergeRequest {
  const cfg = opts.cfg ?? loadConfig();
  return withPrLock(key, () => {
    const pr = readPr(key);
    if (!pr) throw new PrMergeRefused(404, 'lobstah has no record of that PR. Watch it first.');
    if (pr.state !== 'OPEN') throw new PrMergeRefused(409, `That PR is ${pr.state.toLowerCase()}.`);
    if (!mayAutoWatch(prAuthorship(pr, opts.viewer ?? (() => githubViewer())))) {
      throw new PrMergeRefused(403, 'Only your own PRs, or ones a dispatch opened, merge from the glass.');
    }
    const request: PrMergeRequest = pr.mergeRequest ?? {
      at: new Date(opts.now ?? Date.now()).toISOString(),
      by,
      method: prMergeMethod(cfg, pr.repo),
    };
    writePr({ ...pr, mergeRequest: request });
    // Its watch checks it every poll; a PR watched by no one yet gets one.
    const ref = parsePrRef(pr.url);
    if (ref && !readWatch(ref.key)) addPrWatch(ref);
    return request;
  });
}

/** Withdraw a PR's merge request. True when there was one. */
export function cancelPrMerge(key: string): boolean {
  return withPrLock(key, () => {
    const pr = readPr(key);
    if (!pr?.mergeRequest) return false;
    const { mergeRequest: _gone, ...rest } = pr;
    writePr(rest);
    return true;
  });
}

/** Whether an open PR sits below this one in its stack: its base is that PR's branch. */
export function openPrBelow(pr: PrRecord, records: readonly PrRecord[]): boolean {
  return records.some((r) => r.key !== pr.key && r.repo === pr.repo && r.state === 'OPEN' && r.headRefName === pr.baseRefName);
}

/** Test seams for the merge pass. */
export interface PrMergeDeps {
  merge?: (pr: PrRecord, method: PrMergeMethod) => { ok: true } | { ok: false; why: string };
  now?: number;
}

/** `gh pr merge` on exactly the head that was checked. */
function ghMerge(pr: PrRecord, method: PrMergeMethod): { ok: true } | { ok: false; why: string } {
  const res = spawnSync('gh', ['pr', 'merge', pr.url, `--${method}`, '--match-head-commit', pr.headSha], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return res.status === 0 ? { ok: true } : { ok: false, why: (res.stderr || res.stdout || `gh exited ${res.status}`).trim().split('\n')[0]! };
}

/**
 * The daemon's pass over merge requests, once per tick:
 * - a green, mergeable PR at the bottom of its stack merges with its method;
 * - a failing or conflicting PR is repaired: lobstah's PR repair already
 *   covers a dispatch's PR; for one no dispatch owns, this files one repair
 *   dispatch per head, after which the repair chain takes the next rounds;
 * - a PR whose repair stopped tells the helm once per head;
 * - anything else waits for the next check.
 */
export function mergeRequestedPrs(log: (message: string) => void, deps: PrMergeDeps = {}): void {
  const records = readPrs();
  const cfg = loadConfig();
  for (const record of records) {
    if (!record.mergeRequest) continue;
    withPrLock(record.key, () => {
      const pr = readPr(record.key);
      const request = pr?.mergeRequest;
      if (!pr || !request) return;
      const step = prMergeStep(pr, openPrBelow(pr, records));
      if (step.kind === 'done') {
        const { mergeRequest: _done, ...rest } = pr;
        writePr(rest);
        return;
      }
      if (step.kind === 'merge') {
        const result = (deps.merge ?? ghMerge)(pr, request.method);
        if (result.ok) {
          log(`merged ${pr.key} (${request.method}), as asked from the glass`);
          const { mergeRequest: _merged, ...rest } = pr;
          writePr(rest);
        } else {
          log(`could not merge ${pr.key}, will try again: ${result.why}`);
        }
        return;
      }
      if (step.kind === 'stuck') {
        if (request.stuckHeadSha === pr.headSha) return;
        writePr({ ...pr, mergeRequest: { ...request, stuckHeadSha: pr.headSha } });
        postNotice({
          kind: 'repair-stopped',
          text: `#${pr.number} ${pr.title ?? ''}: asked to merge when green, but its repair stopped (${step.why}). It needs you. (${pr.url})`.replace(/ +/g, ' '),
          refId: pr.key,
          dedupeKey: `merge-stuck-${pr.key}-${pr.headSha}`,
        });
        return;
      }
      if (step.kind === 'repair') {
        // A dispatch's PR: the daemon's PR repair already works it ([watch].autoRepair).
        if (pr.dispatches.length > 0) return;
        // One repair dispatch per head. Once it reports this PR, the PR is a dispatch's and its chain takes the next rounds.
        if (request.repair?.headSha === pr.headSha) return;
        const repo = repoKeyForForge(cfg, pr.repo);
        if (!repo) {
          log(`cannot repair ${pr.key} for its merge: no configured repo has ${pr.repo} as its origin`);
          return;
        }
        const id = randomUUID();
        enqueue({ id, repo, trapAny: true, brief: repairBrief(pr, step.why) });
        writePr({ ...pr, mergeRequest: { ...request, repair: { dispatchId: id, headSha: pr.headSha } } });
        log(`filed repair ${id.slice(0, 8)} for ${pr.key} (${step.why}), so its merge can go ahead`);
      }
    });
  }
}

/** The brief for a repair of a PR no dispatch owns. */
export function repairBrief(pr: PrRecord, why: 'checks' | 'conflict'): string {
  const what =
    why === 'conflict'
      ? `It conflicts with its base, \`${pr.baseRefName}\`. Merge \`${pr.baseRefName}\` into it with a merge commit and resolve the conflicts.`
      : `Its checks fail${pr.failingChecks?.length ? `: ${pr.failingChecks.map((c) => c.name).join(', ')}` : ''}. Find why, and fix it.`;
  return [
    `# Get #${pr.number} green so it merges`,
    '',
    `Chris asked the glass to merge ${pr.url} (${pr.title ?? 'untitled'}) once it's green. ${what}`,
    '',
    `- Work on its branch, \`${pr.headRefName}\`, and push to it. Don't open a new PR, rebase or force-push.`,
    `- Keep the change to what makes it green.`,
    `- Report \`done --pr ${pr.url}\` once it's pushed. lobstah merges it when its checks pass.`,
  ].join('\n');
}
