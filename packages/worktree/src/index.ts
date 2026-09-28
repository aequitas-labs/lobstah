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

/** What git prints when another git process holds a lock this one needs. */
const LOCK_CONTENTION = [/cannot lock ref/, /unable to update local ref/, /Unable to create '[^']*\.lock': File exists/];

export function isLockContention(err: unknown): boolean {
  const text = `${(err as { stderr?: string }).stderr ?? ''}\n${err instanceof Error ? err.message : ''}`;
  return LOCK_CONTENTION.some((re) => re.test(text));
}

/**
 * git against the shared repo, retrying lock contention. Each dispatch
 * allocates in its own runner process, so dispatches claimed in one poll
 * fetch into the same repo at once. Git lets one of them update
 * refs/remotes/origin/<trunk>, and the rest fail "cannot lock ref" with
 * nothing wrong: they all want the same result, so the losers wait and retry.
 * Anything else still fails at once.
 */
async function gitShared(cwd: string, ...args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await git(cwd, ...args);
    } catch (err) {
      if (attempt >= 6 || !isLockContention(err)) throw err;
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
