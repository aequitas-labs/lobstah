import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  bounceTrapMessages,
  forgetRoster,
  gitCommonDir,
  protectedRevision,
  readReservation,
  readTrap,
  readTrapAnchor,
  releaseSignedOff,
  rosterByAddress,
  trapLabel,
  trapRef,
  TRAP_ANCHOR_FILE,
  type Config,
} from '@lobstah/core';
import { removeIfSafe } from '@lobstah/worktree';

/** A forget that would lose work: the message names it. `--force` overrides. */
export class ForgetRefusedError extends Error {}

export interface ForgetResult {
  trap: string;
  worktree: 'removed' | 'kept' | 'absent';
  worktreeNote?: string;
  ref: 'deleted' | 'absent';
  /** Branches removal deleted, and branches kept with why. */
  branchDeleted?: string[];
  branchKept?: string[];
  /** Commits on no remote that a forced forget let go of from the protected ref. */
  dropped: string[];
  bounced: number;
}

function git(gitDir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** Modified or untracked files in a checkout, apart from the trap anchor. */
function unsavedFiles(dir: string): string[] | undefined {
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return undefined;
  return r.stdout.split('\n').filter((l) => l.trim() && l.slice(3) !== TRAP_ANCHOR_FILE).map((l) => l.slice(3));
}

/**
 * `lobstah man roster forget <trap>`: the trap leaves the roster for good.
 * Its worktree is removed (one soak did not create is left in place, minus
 * its anchor), its protected ref is deleted, held messages bounce, and its
 * name is freed. A live or starting trap refuses. Work that exists nowhere
 * else refuses unless `force`: modified or untracked files in the checkout,
 * and commits (in the protected ref, the checkout, or its branch) that are
 * on no remote branch and not merged to trunk. A branch with such commits is
 * kept even when forced; only the ref goes.
 */
export async function forgetTrap(address: string, cfg: Config, opts: { force?: boolean } = {}): Promise<ForgetResult> {
  const entry = rosterByAddress(address);
  if (!entry) throw new Error(`no roster record for ${address} — \`lobstah man roster\` lists them`);
  const label = trapLabel(entry);
  if (readTrap(entry.trapId)) throw new ForgetRefusedError(`${label} is signed on — never forget a live trap; stow it first`);
  if (readReservation(entry.trapId)) throw new ForgetRefusedError(`${label} is starting (reserved) — withdraw it with \`lobstah stow --wt ${entry.name}\` first`);

  const repo = entry.repo ? cfg.repos[entry.repo] : undefined;
  const gitDir = entry.gitDir ?? (repo ? gitCommonDir(repo.path) : undefined);
  const present = fs.existsSync(entry.worktree);
  const anchored = present && readTrapAnchor(entry.worktree)?.trapId === entry.trapId;

  // What exists nowhere else.
  const unsaved = anchored ? unsavedFiles(entry.worktree) : [];
  if (unsaved === undefined && !opts.force) throw new ForgetRefusedError(`cannot read git status in ${entry.worktree} — inspect it, or pass --force`);
  const tips: string[] = [];
  const kept = gitDir ? protectedRevision(gitDir, entry.trapId) : undefined;
  if (kept) tips.push(kept);
  if (anchored) {
    const head = spawnSync('git', ['-C', entry.worktree, 'rev-parse', '-q', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
    if (head.status === 0) tips.push(head.stdout.trim());
  }
  for (const branch of new Set([entry.branch, entry.soakBranch].filter((b): b is string => !!b))) {
    const tip = gitDir ? git(gitDir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`) : undefined;
    if (tip?.ok) tips.push(tip.out);
  }
  let unpushed: string[] = [];
  if (gitDir && tips.length) {
    const trunk = repo?.trunk && git(gitDir, 'rev-parse', '-q', '--verify', `refs/heads/${repo.trunk}`).ok ? [`refs/heads/${repo.trunk}`] : [];
    const log = git(gitDir, 'log', '--format=%h %s', ...new Set(tips), '--not', '--remotes', ...trunk);
    if (!log.ok && !opts.force) throw new ForgetRefusedError(`cannot tell which of ${label}'s commits are on a remote — pass --force to forget it anyway`);
    unpushed = log.ok && log.out ? log.out.split('\n') : [];
  }
  if (!opts.force && (unsaved!.length > 0 || unpushed.length > 0)) {
    const parts = [
      ...(unsaved!.length ? [`${unsaved!.length} unsaved file(s) in ${entry.worktree}: ${unsaved!.slice(0, 5).join(', ')}${unsaved!.length > 5 ? ', …' : ''}`] : []),
      ...(unpushed.length
        ? [`${unpushed.length} commit(s) on no remote branch and not merged to ${repo?.trunk ?? 'trunk'}:\n${unpushed.slice(0, 10).map((c) => `  ${c}`).join('\n')}${unpushed.length > 10 ? '\n  …' : ''}`]
        : []),
    ];
    throw new ForgetRefusedError(`not forgetting ${label}: it holds work that exists nowhere else — ${parts.join('; ')}\nPush or merge it, or pass --force to forget the trap anyway.`);
  }

  const result: ForgetResult = { trap: label, worktree: present ? 'kept' : 'absent', ref: 'absent', dropped: opts.force ? unpushed : [], bounced: 0 };
  if (present) {
    if (anchored && readTrapAnchor(entry.worktree)?.createdBy === 'soak') {
      const removal = await removeIfSafe(entry.worktree, {
        ignore: [TRAP_ANCHOR_FILE],
        branches: [entry.branch, entry.soakBranch].filter((b): b is string => !!b),
        force: true,
      });
      if (removal.removed) {
        result.worktree = 'removed';
        if (removal.deletedBranches.length) result.branchDeleted = removal.deletedBranches;
        if (removal.keptBranches.length) result.branchKept = removal.keptBranches.map((b) => `${b.branch} (${b.reason})`);
      } else {
        throw new Error(`could not remove ${entry.worktree}: ${removal.reason} — the trap is not forgotten`);
      }
    } else {
      if (anchored) fs.rmSync(`${entry.worktree}/${TRAP_ANCHOR_FILE}`, { force: true });
      result.worktreeNote = 'soak did not create it: left in place, its trap anchor removed';
    }
  }
  if (gitDir && kept && git(gitDir, 'update-ref', '-d', trapRef(entry.trapId)).ok) result.ref = 'deleted';
  result.bounced = bounceTrapMessages(entry.trapId);
  releaseSignedOff(entry.trapId);
  forgetRoster(entry.trapId);
  return result;
}
