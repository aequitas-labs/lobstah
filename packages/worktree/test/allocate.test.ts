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
    // update refs/remotes/origin/main; the rest used to fail "cannot lock ref" or,
    // on git 2.51+, "incorrect old value provided".
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
    // Every wording git uses for the benign race, oldest first.
    const races = [
      "error: cannot lock ref 'refs/remotes/origin/main': is at 91fb380b but expected 6e47963e",
      " ! 91fb380..6e47963  main       -> origin/main  (unable to update local ref)",
      "fatal: Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.",
      // git 2.53.0, captured verbatim from a losing concurrent fetch.
      [
        'From /tmp/racerepro.RKlm/origin',
        ' * branch            main       -> FETCH_HEAD',
        '   b3b1f3a..f808e5b  main       -> origin/main',
        'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided',
        '',
      ].join('\n'),
      // git 2.53.0, when the ref's lock file is held (see the test below).
      'error: fetching ref refs/remotes/origin/main failed: reference already exists',
    ];
    for (const stderr of races) expect(isLockContention(contention(stderr)), stderr).toBe(true);

    const real = [
      "fatal: couldn't find remote ref main",
      'fatal: Authentication failed',
      "fatal: repository '/r/origin.git' not found",
      "fatal: a branch named 'lobstah/x' already exists",
      'error: fetching ref refs/remotes/origin/main failed: invalid new value provided',
    ];
    for (const stderr of real) expect(isLockContention(contention(stderr)), stderr).toBe(false);
  });

  it('names lock contention and keeps git stderr when retries run out', async () => {
    // A stale lock file that never goes away: every fetch loses, so the
    // bounded retry gives up and the failure must say why.
    const repo = repoBehindOrigin();
    fs.writeFileSync(path.join(repo.path, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');
    const err = await allocate(repo, '00000000-0000-4000-8000-0000000000ff').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/^git fetch origin main: lock contention, 6 attempts\n/);
    // git's own words follow: "Unable to create '...main.lock': File exists"
    // before 2.51, "fetching ref ... failed: reference already exists" after.
    expect(err?.message).toMatch(/main\.lock': File exists|fetching ref refs\/remotes\/origin\/main failed/);
  }, 20_000);
});
