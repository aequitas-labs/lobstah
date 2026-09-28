import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lobstahHome } from '@lobstah/core';
import type { RepoConfig } from '@lobstah/core';

const run = promisify(execFile);
const shell = promisify(exec);

export function worktreePath(id: string): string {
  return path.join(lobstahHome(), 'worktrees', id);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: process.env });
  return stdout.trim();
}

/**
 * What git prints when another git process won a race for a ref or lock this
 * one needs. Each pattern is the stable part of the message, not a whole line.
 */
const LOCK_CONTENTION = [
  // All versions: the ref's lock file is held, or the ref moved under us
  // ("cannot lock ref '<ref>': is at <a> but expected <b>").
  /cannot lock ref/,
  // All versions: fetch's per-ref summary line when a ref update failed.
  /unable to update local ref/,
  // All versions: another process holds a lock file (index, config, a ref).
  /Unable to create '[^']*\.lock': File exists/,
  // git 2.51 and later: fetch batches its ref updates and reports a loser as
  // "error: fetching ref <ref> failed: incorrect old value provided". The
  // reason is git's untranslated ref-transaction text; it means another
  // process moved the ref between our read and our write, which on a shared
  // fetch is the same benign race as "cannot lock ref" above.
  /incorrect old value provided/,
  // git 2.51 and later: the same batched report when the ref's lock file is
  // held by another process ("fetching ref <ref> failed: reference already
  // exists"). The files backend maps the lock's EEXIST to this reason; older
  // git printed "Unable to create '<ref>.lock': File exists" instead.
  /reference already exists/,
];

/** git's stderr, falling back to the error message. */
function gitStderr(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  return (stderr ?? (err instanceof Error ? err.message : String(err))).trim();
}

export function isLockContention(err: unknown): boolean {
  const text = `${(err as { stderr?: string }).stderr ?? ''}\n${err instanceof Error ? err.message : ''}`;
  return LOCK_CONTENTION.some((re) => re.test(text));
}

const ATTEMPTS = 6;

/**
 * git against the shared repo, retrying lock contention. Each dispatch
 * allocates in its own runner process, so dispatches claimed in one poll
 * fetch into the same repo at once. Git lets one of them update
 * refs/remotes/origin/<trunk>, and the rest fail ("cannot lock ref", or on
 * git 2.51+ "incorrect old value provided") with nothing wrong: they all
 * want the same result, so the losers wait and retry.
 * Anything else still fails at once.
 */
async function gitShared(cwd: string, ...args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await git(cwd, ...args);
    } catch (err) {
      if (!isLockContention(err)) throw err;
      if (attempt >= ATTEMPTS) {
        // Name the cause and keep git's words, so a new wording or a stuck
        // lock is visible at once, not a generic allocation failure.
        throw new Error(`git ${args.join(' ')}: lock contention, ${attempt} attempts\n${gitStderr(err)}`, { cause: err });
      }
      // 100ms doubling to 3.2s, jittered so retries do not collide again.
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1) * (0.5 + Math.random())));
    }
  }
}

/**
 * One worktree per dispatch, branched from trunk. Never reuse a worktree
 * across dispatches, and never allocate a second one for the same id.
 */
export async function allocate(repo: RepoConfig, id: string): Promise<string> {
  const dir = worktreePath(id);
  if (fs.existsSync(dir)) {
    throw new Error(`worktree for ${id} already exists at ${dir} — never allocate a second`);
  }
  if (!fs.existsSync(repo.path)) {
    if (!repo.origin) throw new Error(`repo path ${repo.path} missing and no origin configured`);
    await run('git', ['clone', repo.origin, repo.path], { env: process.env });
  }
  await gitShared(repo.path, 'fetch', 'origin', repo.trunk);
  // --no-track: an upstream of origin/<trunk> under another branch name is
  // never useful, and writing it takes .git/config's lock, which concurrent
  // allocations contend for too.
  await gitShared(repo.path, 'worktree', 'add', '--no-track', dir, '-b', `lobstah/${id}`, `origin/${repo.trunk}`);
  for (const cmd of repo.setup ?? []) {
    await shell(cmd, { cwd: dir, env: { ...process.env, ...(repo.env ?? {}) } });
  }
  return dir;
}

export async function collectEvidence(repo: RepoConfig, id: string): Promise<{ branch: string; commits: string[] }> {
  const dir = worktreePath(id);
  const branch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const log = await git(dir, 'log', '--oneline', `origin/${repo.trunk}..HEAD`);
  return { branch, commits: log ? log.split('\n') : [] };
}

export async function remove(repo: RepoConfig, id: string): Promise<void> {
  const dir = worktreePath(id);
  if (!fs.existsSync(dir)) return;
  await git(repo.path, 'worktree', 'remove', '--force', dir);
}
