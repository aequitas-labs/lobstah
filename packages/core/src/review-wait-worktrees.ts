import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { configuredFolderOverlaps } from './configured-trap-slots.js';
import { laneDirs } from './paths.js';
import { worktreesDir } from './disk.js';
import { dispatchPrUrls, parsePrRef } from './pr.js';
import { readPrs, type PrRecord } from './prs.js';
import { readEvidence } from './evidence.js';
import { storedDescriptor } from './queue.js';
import { readStatusLog } from './status.js';
import { listTraps } from './soak.js';
import { dispatchWorktree, followUpAncestors } from './worktrees.js';
import type { Lane } from './types.js';

/** A finished chain's checkout, retained only for PRs that need another review. */
export interface ReviewWaitWorktree {
  owner: string;
  worktree: string;
  repo: string;
  heads: string[];
}

/** Unknown checks or review threads are not proof that review is the only remaining work. */
function onlyWaitingForReview(pr: PrRecord): boolean {
  return !!pr.checks && pr.state === 'OPEN' && !pr.draft && !pr.discoveryPending &&
    !pr.checks.unknown && pr.checks.failed === 0 && pr.checks.pending === 0 &&
    pr.checks.passed === pr.checks.total &&
    pr.reviewDecision === 'REVIEW_REQUIRED' &&
    ['CLEAN', 'BLOCKED'].includes(pr.mergeStateStatus) &&
    pr.review?.unresolvedThreads === 0 && !pr.review.changesRequested &&
    pr.repair === undefined;
}

const names = (dir: string): string[] => {
  try { return fs.readdirSync(dir).filter((name) => !name.startsWith('.')); } catch { return []; }
};

/** Never offer live, shared-with-live, external, or unobserved PR checkouts for pressure cleanup. */
export function reviewWaitWorktrees(cfg: Config = loadConfig()): ReviewWaitWorktree[] {
  const records = new Map(readPrs().map((pr) => [pr.key, pr]));
  const refsByDispatch = new Map<string, Set<string>>();
  for (const pr of records.values()) for (const id of pr.dispatches ?? []) {
    if (!refsByDispatch.has(id)) refsByDispatch.set(id, new Set());
    refsByDispatch.get(id)!.add(pr.key);
  }
  const canonical = (directory: string): string => {
    let result: string;
    try { result = fs.realpathSync.native(directory); } catch { result = path.resolve(directory); }
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  const traps = listTraps().filter((trap) => typeof trap.worktree === 'string').map((trap) => canonical(trap.worktree));
  const busy = new Set<string>();
  const owners = new Map<string, { repo: string; refs: Set<string>; finished: boolean }>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    const dirs = laneDirs(lane);
    for (const id of [...names(dirs.queue).map((name) => name.replace(/\.json$/, '')), ...names(dirs.active)]) {
      for (const user of [id, ...followUpAncestors(id, lane)]) busy.add(dispatchWorktree(user).owner);
    }
    for (const id of names(dirs.done)) {
      const descriptor = storedDescriptor(id, lane);
      if (!descriptor?.repo) continue;
      const owner = dispatchWorktree(id, lane).owner;
      const current = owners.get(owner) ?? { repo: descriptor.repo, refs: new Set<string>(), finished: true };
      const verb = readStatusLog(id, lane).at(-1)?.verb;
      if (current.repo !== descriptor.repo || (verb !== 'done' && verb !== 'failed')) current.finished = false;
      for (const key of refsByDispatch.get(id) ?? []) current.refs.add(key);
      for (const url of [...dispatchPrUrls(readEvidence(id, lane)), ...(descriptor.pr?.url ? [descriptor.pr.url] : [])]) {
        const ref = parsePrRef(url);
        if (ref) current.refs.add(ref.key);
      }
      owners.set(owner, current);
    }
  }
  const result: ReviewWaitWorktree[] = [];
  for (const [owner, usage] of owners) {
    const worktree = path.join(worktreesDir(), owner);
    if (busy.has(owner) || !usage.finished || !usage.refs.size || !cfg.repos[usage.repo] || !fs.existsSync(worktree)) continue;
    if (configuredFolderOverlaps(worktree)) continue;
    if (traps.some((trap) => {
      const relative = path.relative(canonical(worktree), trap);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    })) continue;
    const prs = [...usage.refs].flatMap((key) => { const pr = records.get(key); return pr ? [pr] : []; });
    if (prs.length !== usage.refs.size || !prs.some((pr) => pr.state === 'OPEN')) continue;
    if (prs.some((pr) => pr.state === 'OPEN' ? !onlyWaitingForReview(pr) : !['MERGED', 'CLOSED'].includes(pr.state))) continue;
    result.push({ owner, repo: usage.repo, worktree, heads: prs.map((pr) => pr.headSha) });
  }
  return result;
}
