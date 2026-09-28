import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RepoConfig } from '@lobstah/core';
import { allocate, isLockContention } from '../src/index.js';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wt-'));
  process.env.LOBSTAH_HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.LOBSTAH_HOME);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

/** A repo whose origin/main is one commit behind origin, so every fetch must update the ref. */
function repoBehindOrigin(): RepoConfig {
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, clone);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'two');
  git(seed, 'push', '-q', 'origin', 'main');
  return { path: clone, trunk: 'main' } as RepoConfig;
}

describe('allocate', () => {
  it('concurrent dispatches all get a worktree on the fetched trunk', async () => {
    // Each dispatch allocates in its own runner process, so several claimed
    // in one poll fetch into the same repo at once. Git lets one of them
    // update refs/remotes/origin/main; the rest used to fail "cannot lock ref".
    const repo = repoBehindOrigin();
    const tip = git(path.join(root, 'origin.git'), 'rev-parse', 'main');
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const results = await Promise.allSettled(ids.map((id) => allocate(repo, id)));
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
    for (const r of results) {
      if (r.status === 'fulfilled') expect(git(r.value, 'rev-parse', 'HEAD')).toBe(tip);
    }
  });

  it('retries only lock contention, not real failures', () => {
    const contention = (stderr: string) => Object.assign(new Error(`Command failed: git fetch\n${stderr}`), { stderr });
    expect(isLockContention(contention(
      "error: cannot lock ref 'refs/remotes/origin/main': is at 91fb380b but expected 6e47963e",
    ))).toBe(true);
    expect(isLockContention(contention(
      "fatal: Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.",
    ))).toBe(true);
    expect(isLockContention(contention("fatal: couldn't find remote ref main"))).toBe(false);
    expect(isLockContention(contention('fatal: Authentication failed'))).toBe(false);
  });
});
