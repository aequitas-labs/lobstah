import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { RepoConfig } from '@lobstah/core';
import { allocate, isLockContention } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wt-'));
  process.env.LOBSTAH_HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.LOBSTAH_HOME);
});
afterEach(() => {
  removeTempDir(root);
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

/**
 * Run `fn` with git's event trace on, and return the git processes it ran,
 * by subcommand, as [start, exit] times in ms, oldest first. Trace2 writes
 * one file per git process.
 */
async function traced<T>(fn: () => Promise<T>): Promise<{ value: T; runs: (cmd: string) => Array<[number, number]> }> {
  const dir = path.join(root, 'trace');
  fs.mkdirSync(dir);
  process.env.GIT_TRACE2_EVENT = dir;
  let value: T;
  try {
    value = await fn();
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
  }
  const spans: Array<{ cmd: string; span: [number, number] }> = [];
  for (const file of fs.readdirSync(dir)) {
    let start = 0;
    let exit = 0;
    let argv: string[] = [];
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line) as { event: string; time: string; argv?: string[] };
      if (e.event === 'start') [start, argv] = [Date.parse(e.time), e.argv ?? []];
      if (e.event === 'exit') exit = Date.parse(e.time);
    }
    spans.push({ cmd: argv[1] ?? '', span: [start, exit] });
  }
  spans.sort((a, b) => a.span[0] - b.span[0]);
  return { value, runs: (cmd) => spans.filter((s) => s.cmd === cmd).map((s) => s.span) };
}

/** Each span starts after the one before it ended. */
function expectOneAtATime(spans: Array<[number, number]>): void {
  for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
}

// Allocations in one repo take turns, and each git step takes about 0.4s on
// Windows CI, so these tests get more than the default 5s.
describe('allocate', () => {
  it('concurrent dispatches all get a worktree on the fetched trunk, from one fetch', async () => {
    // Several dispatches claimed in one poll allocate in the same repo at
    // once. Parallel fetches used to collide on refs/remotes/origin/main and,
    // on Windows, on the loose objects they unpack ("unable to write file
    // .git/objects/..: Permission denied"), and a parallel `git worktree add`
    // read another's half-written .git/worktrees/<id>. Now they take turns,
    // and callers that asked before a fetch started reuse it.
    const repo = repoBehindOrigin();
    const tip = git(path.join(root, 'origin.git'), 'rev-parse', 'main');
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const results = await traced(() => Promise.allSettled(ids.map((id) => allocate(repo, id))));
    const failures = results.value.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
    for (const r of results.value) {
      if (r.status === 'fulfilled') expect(git(r.value, 'rev-parse', 'HEAD')).toBe(tip);
    }
    expect(results.runs('fetch')).toHaveLength(1);
    expectOneAtATime(results.runs('worktree'));
  }, 20_000);

  it('fetches of different refs in one repo run one at a time', async () => {
    const repo = repoBehindOrigin();
    const seed = path.join(root, 'seed');
    git(seed, 'push', '-q', 'origin', 'main:side');
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000003${i}`);
    const results = await traced(() => Promise.all(ids.map((id, i) => allocate(repo, id, i % 2 ? 'side' : 'main'))));
    expect(results.value).toHaveLength(6);
    expect(results.runs('fetch').length).toBeGreaterThanOrEqual(2);
    expectOneAtATime(results.runs('fetch'));
  }, 20_000);

  it('fetches again for a dispatch that asks after the last fetch started', async () => {
    const repo = repoBehindOrigin();
    await allocate(repo, '00000000-0000-4000-8000-000000000010');
    git(path.join(root, 'seed'), 'commit', '-q', '--allow-empty', '-m', 'three');
    git(path.join(root, 'seed'), 'push', '-q', 'origin', 'main');
    const tip = git(path.join(root, 'origin.git'), 'rev-parse', 'main');
    const dir = await allocate(repo, '00000000-0000-4000-8000-000000000011');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(tip);
  }, 20_000);

  it('waits while another live process holds the repo lock, and takes over a dead one', async () => {
    const repo = repoBehindOrigin();
    const lock = path.join(repo.path, '.git', 'lobstah-git.lock');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const exited = new Promise((r) => holder.once('exit', r));
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
      let done = false;
      const first = allocate(repo, '00000000-0000-4000-8000-000000000020').finally(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 1000));
      expect(done).toBe(false);
      fs.rmSync(lock);
      await first;
    } finally {
      holder.kill();
    }
    await exited;
    // The holder is gone now: its lock is stale and the next fetch takes it.
    fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
    await allocate(repo, '00000000-0000-4000-8000-000000000021');
    expect(fs.existsSync(lock)).toBe(false);
  }, 20_000);

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
      // Windows, verbatim from a losing concurrent fetch in CI.
      [
        'error: unable to write file .git/objects/6b/329ddc0e99dc6ef36f47253c87b191399bfc95: Permission denied',
        'fatal: failed to write object',
        'fatal: unpack-objects failed',
      ].join('\n'),
    ];
    for (const stderr of races) expect(isLockContention(contention(stderr)), stderr).toBe(true);

    const real = [
      "fatal: couldn't find remote ref main",
      'fatal: Authentication failed',
      'error: unable to write file .git/config: Permission denied',
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
