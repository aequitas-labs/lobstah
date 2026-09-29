import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  chainPr,
  currentBranchAt,
  hasOpenCatch,
  laneDirs,
  listTraps,
  loadConfig,
  parsePrRef,
  readEvidence,
  readSessionClaim,
  readStatusLog,
  storedDescriptor,
  TERMINAL_VERBS,
} from '@lobstah/core';
import type { Lane, PrRecord } from '@lobstah/core';
import { githubRepoFromOrigin } from '@lobstah/pick';
import { prsBelow } from './glass-prs.js';

/**
 * What a live worker holds. A live worker is an active headless dispatch,
 * or a signed-on trap with an open catch. It holds a branch when its
 * worktree has the branch checked out, when its current branch tracks the
 * branch on the remote, or when it pushed the branch during its current
 * dispatch (evidence `pushes`). It holds a PR when its evidence names the
 * PR or its chain owns the PR.
 */
export interface WorkerHold {
  /** `wt:<name>` for a trap, `dispatch:<id8>` for a headless dispatch. */
  label: string;
  dispatchId: string;
  /** The worker's forge repo (`owner/repo`), when known. */
  forgeRepo?: string;
  /** Branch → how the worker holds it. */
  branches: Map<string, string>;
  /** PR key → how the worker holds it. */
  prs: Map<string, string>;
}

export interface RepairHold {
  heldBy: string;
  reason: string;
}

interface LiveWorker {
  label: string;
  dispatchId: string;
  lane: Lane;
  worktree?: string;
  repo?: string;
}

function terminal(id: string, lane: Lane): boolean {
  const last = readStatusLog(id, lane).at(-1)?.verb;
  return last !== undefined && TERMINAL_VERBS.includes(last);
}

/** Active headless dispatches and traps with an open catch. */
export function liveWorkers(): LiveWorker[] {
  const out: LiveWorker[] = [];
  for (const reg of listTraps()) {
    if (!hasOpenCatch(reg)) continue;
    out.push({
      label: `wt:${reg.name ?? reg.trapId}`,
      dispatchId: reg.claimed!,
      lane: 'work',
      worktree: reg.worktree,
      repo: storedDescriptor(reg.claimed!, 'work')?.repo ?? reg.repo,
    });
  }
  for (const lane of ['work', 'chore'] as Lane[]) {
    let ids: string[];
    try {
      ids = fs.readdirSync(laneDirs(lane).active).filter((id) => !id.startsWith('.'));
    } catch {
      continue;
    }
    for (const id of ids) {
      // A trap's catch counts only while its trap is live (above).
      if (readSessionClaim(id, lane) || terminal(id, lane)) continue;
      if (!fs.existsSync(path.join(laneDirs(lane).active, id))) continue;
      out.push({
        label: `dispatch:${id.slice(0, 8)}`,
        dispatchId: id,
        lane,
        worktree: readEvidence(id, lane).worktree,
        repo: storedDescriptor(id, lane)?.repo,
      });
    }
  }
  return out;
}

function git(cwd: string, args: string[]): string | undefined {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && !res.error ? res.stdout.trim() : undefined;
}

/** The daemon asks every tick; a branch's upstream and a checkout's origin rarely change. */
const GIT_CACHE_MS = 60_000;
const gitCache = new Map<string, { at: number; upstream?: string; origin?: string }>();

/** The upstream of the checked-out branch and the origin URL of a worktree, cached per branch. */
function gitFacts(worktree: string, branch: string, now = Date.now()): { upstream?: string; origin?: string } {
  const key = `${worktree}\0${branch}`;
  const hit = gitCache.get(key);
  if (hit && now - hit.at < GIT_CACHE_MS) return hit;
  const facts = {
    at: now,
    upstream: git(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    origin: git(worktree, ['remote', 'get-url', 'origin']),
  };
  gitCache.set(key, facts);
  return facts;
}

/** What one live worker holds, read from its evidence, its chain, and its worktree. */
export function workerHold(worker: LiveWorker): WorkerHold {
  const branches = new Map<string, string>();
  const prs = new Map<string, string>();
  const evidence = readEvidence(worker.dispatchId, worker.lane);
  const origin = worker.repo ? loadConfig().repos[worker.repo]?.origin : undefined;
  let forgeRepo = origin ? githubRepoFromOrigin(origin) : undefined;
  if (worker.worktree && fs.existsSync(worker.worktree)) {
    const branch = currentBranchAt(worker.worktree);
    if (branch) {
      branches.set(branch, `has ${branch} checked out`);
      const { upstream, origin: url } = gitFacts(worker.worktree, branch);
      const slash = upstream?.indexOf('/') ?? -1;
      if (upstream && slash > 0) {
        const remoteBranch = upstream.slice(slash + 1);
        if (!branches.has(remoteBranch)) branches.set(remoteBranch, `tracks ${upstream}`);
      }
      if (!forgeRepo && url) forgeRepo = githubRepoFromOrigin(url);
    }
  }
  for (const push of evidence.pushes ?? []) {
    if (!branches.has(push.branch)) branches.set(push.branch, `pushed ${push.branch} at ${push.at}`);
  }
  const named = evidence.prUrl ? parsePrRef(evidence.prUrl) : undefined;
  if (named) prs.set(named.key, 'works on this PR');
  const owned = chainPr(worker.dispatchId, worker.lane);
  const ownedRef = owned ? parsePrRef(owned.url) : undefined;
  if (ownedRef && !prs.has(ownedRef.key)) prs.set(ownedRef.key, 'its chain owns this PR');
  return { label: worker.label, dispatchId: worker.dispatchId, ...(forgeRepo ? { forgeRepo } : {}), branches, prs };
}

/** Every live worker and what it holds. */
export function readWorkerHolds(): WorkerHold[] {
  return liveWorkers().map(workerHold);
}

/**
 * Whether a live worker holds this PR: its head branch, or the head branch
 * of an open PR below it in the same stack (glass-prs.ts). The first
 * holder found is returned, with the reason.
 */
export function repairHold(pr: PrRecord, records: readonly PrRecord[], workers: readonly WorkerHold[]): RepairHold | undefined {
  const targets = [
    { key: pr.key, repo: pr.repo, head: pr.headRefName, number: pr.number, below: false },
    ...prsBelow(records, pr.key)
      .filter((p) => p.state === 'OPEN')
      .map((p) => ({ key: p.key, repo: p.forgeRepo, head: p.headRefName, number: p.number, below: true })),
  ];
  for (const target of targets) {
    for (const worker of workers) {
      if (worker.forgeRepo && worker.forgeRepo !== target.repo) continue;
      const how = worker.prs.get(target.key) ?? (target.head ? worker.branches.get(target.head) : undefined);
      if (!how) continue;
      const where = target.below ? `; #${target.number} is below this PR` : '';
      return { heldBy: worker.label, reason: `${worker.label} (dispatch ${worker.dispatchId.slice(0, 8)}) ${how}${where}` };
    }
  }
  return undefined;
}
