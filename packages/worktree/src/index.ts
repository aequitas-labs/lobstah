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
  await git(repo.path, 'fetch', 'origin', repo.trunk);
  await git(repo.path, 'worktree', 'add', dir, '-b', `lobstah/${id}`, `origin/${repo.trunk}`);
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
