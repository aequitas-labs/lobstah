import { spawnSync } from 'node:child_process';
import {
  hasOpenCatch,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  readEvidence,
  readSessionClaim,
  readTrapPrProbe,
  storedDescriptor,
  writeTrapPrProbe,
} from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { autoRegisterPrWatch } from './pr-watch.js';

/** One subprocess run; tests swap in a fake `gh`. */
export type ProbeRun = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string };

const defaultRun: ProbeRun = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: cmd === 'gh' ? 10_000 : 3_000, windowsHide: true });
  return { status: res.error ? null : res.status, stdout: res.stdout ?? '' };
};

export const PR_PROBE_INTERVAL_MS = 60_000;

export type PrProbeResult =
  | { recorded: false; reason: 'no-catch' | 'throttled' | 'no-branch' | 'trunk' | 'no-upstream' | 'before-claim' | 'known' | 'no-pr' }
  | { recorded: true; dispatch: string; prUrl: string; watch?: string };

/**
 * The beat's PR lookup for a trap's open catch. At most once a minute it
 * reads the worktree's branch. When the branch is not trunk and tracks a
 * remote branch of its own, `gh pr view <branch>` names its PR. The branch
 * is this dispatch's only when its head commit is newer than the claim: a
 * trap that took new work on the branch of its last dispatch does not give
 * that dispatch's PR to the new one. A PR not yet
 * in the dispatch's evidence is recorded there and gets its `pr:` watch,
 * as `report --pr` does. Once the PR is found for a branch, later beats on
 * that branch run no gh. Throws on a broken state; the caller logs it.
 */
export function probeTrapPr(reg: TrapRegistration, opts: { now?: number; run?: ProbeRun } = {}): PrProbeResult {
  if (!hasOpenCatch(reg)) return { recorded: false, reason: 'no-catch' };
  const id = reg.claimed!;
  const now = opts.now ?? Date.now();
  const run = opts.run ?? defaultRun;
  const last = readTrapPrProbe(reg.trapId);
  const sameDispatch = last?.dispatch === id;
  if (sameDispatch && now - (Date.parse(last.checkedAt) || 0) < PR_PROBE_INTERVAL_MS) return { recorded: false, reason: 'throttled' };
  const git = (args: string[]) => run('git', args, reg.worktree);
  const head = git(['branch', '--show-current']);
  const branch = head.status === 0 ? head.stdout.trim() : '';
  const known = sameDispatch && last.branch === branch ? last.prUrl : undefined;
  writeTrapPrProbe(reg.trapId, { dispatch: id, branch, checkedAt: new Date(now).toISOString(), ...(known ? { prUrl: known } : {}) });
  if (!branch) return { recorded: false, reason: 'no-branch' };
  const repo = storedDescriptor(id, 'work')?.repo ?? reg.repo;
  const trunk = (repo ? loadConfig().repos[repo]?.trunk : undefined) ?? 'main';
  if (branch === trunk) return { recorded: false, reason: 'trunk' };
  if (known) return { recorded: false, reason: 'known' };
  // A branch cut from origin/<trunk> tracks trunk until its first push.
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const tracked = upstream.status === 0 ? upstream.stdout.trim() : '';
  if (!tracked || tracked.endsWith(`/${trunk}`)) return { recorded: false, reason: 'no-upstream' };
  const claimedAt = Date.parse(readSessionClaim(id, 'work')?.at ?? '');
  if (Number.isFinite(claimedAt)) {
    const committed = git(['log', '-1', '--format=%ct', 'HEAD']);
    const at = committed.status === 0 ? Number(committed.stdout.trim()) * 1000 : NaN;
    if (!(at >= claimedAt)) return { recorded: false, reason: 'before-claim' };
  }
  const view = run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], reg.worktree);
  const prUrl = view.status === 0 ? view.stdout.trim() : '';
  if (!parsePrRef(prUrl)) return { recorded: false, reason: 'no-pr' };
  writeTrapPrProbe(reg.trapId, { dispatch: id, branch, checkedAt: new Date(now).toISOString(), prUrl });
  if (readEvidence(id, 'work').prUrl === prUrl) return { recorded: false, reason: 'known' };
  mergeEvidence(id, 'work', { prUrl });
  const watch = autoRegisterPrWatch(id, prUrl);
  return { recorded: true, dispatch: id, prUrl, ...(watch ? { watch: watch.key } : {}) };
}
