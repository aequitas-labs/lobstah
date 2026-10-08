import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { exec, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  acquireWorktreeLock,
  activeIds,
  chainWorktree,
  dispatchWorktree,
  laneOf,
  listTraps,
  inspectTrapWorktree,
  storedDescriptor,
  worktreeGitDir,
  worktreeHolder,
  worktreePath,
} from '@lobstah/core';
import type { Lane, RepoConfig } from '@lobstah/core';

export { worktreePath };

const run = promisify(execFile);
const shell = promisify(exec);

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
  // Windows: two fetches unpack the same loose object, and one cannot write
  // the file the other holds open ("unable to write file
  // .git/objects/<xx>/<rest>: Permission denied", then "unpack-objects
  // failed"). Only an object path matches, not any denied write.
  /unable to write file \S*objects[\\/][0-9a-f]{2}[\\/][0-9a-f]{38,}: Permission denied/,
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
 * How long a git step waits for another process's step in the same repo. A
 * holder older than this is stale, and after it the waiter runs anyway (the
 * lock-contention retry covers a collision then).
 */
const REPO_LOCK_WAIT_MS = 5 * 60_000;

/** The in-process tail of each repo's queue, by canonical git common dir. */
const repoQueues = new Map<string, Promise<void>>();

interface RepoLock {
  pid: number;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Codes a lock-file create or read hits while another process deletes it (Windows). */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * One attempt at `lobstah-git.lock` in the git common dir: `held` when this
 * call took it, `retry` when a stale holder was just cleared, `wait` while
 * a live holder has it. A lock whose process is gone, or older than
 * REPO_LOCK_WAIT_MS, is stale. `holder` is the live holder's pid.
 */
function takeRepoLock(file: string, mine: string): { state: 'held' | 'retry' | 'wait'; holder?: number } {
  try {
    fs.writeFileSync(file, mine, { flag: 'wx' });
    return { state: 'held' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code !== 'EEXIST' && !BUSY.has(code)) throw err;
  }
  let raw = '';
  let age = 0;
  try {
    raw = fs.readFileSync(file, 'utf8');
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return { state: 'retry' }; // released (or being deleted) between our create and our read
  }
  let holder: RepoLock | undefined;
  try {
    holder = JSON.parse(raw) as RepoLock;
  } catch {
    holder = undefined; // being written, or torn: stale only when old
  }
  const stale = age > REPO_LOCK_WAIT_MS || (holder ? !pidAlive(holder.pid) : age > 5_000);
  if (stale) {
    try {
      if (fs.readFileSync(file, 'utf8') === raw) fs.rmSync(file, { force: true });
    } catch {
      // gone already
    }
    return { state: 'retry' };
  }
  return { state: 'wait', ...(holder ? { holder: holder.pid } : {}) };
}

/** Release the lock when this holder still owns it. */
function releaseRepoLock(file: string, mine: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file, { force: true, recursive: true, maxRetries: 5 });
  } catch {
    // gone already
  }
}

/**
 * Run `fn` while holding `lobstah-git.lock` in the git common dir, so runner
 * processes allocating in one repo take turns. After REPO_LOCK_WAIT_MS the
 * waiter runs anyway (the lock-contention retry covers a collision then).
 */
async function withRepoLock(common: string, fn: () => Promise<void>): Promise<void> {
  const file = path.join(common, 'lobstah-git.lock');
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies RepoLock);
  const deadline = Date.now() + REPO_LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    const took = takeRepoLock(file, mine);
    if (took.state === 'held') {
      held = true;
      break;
    }
    if (took.state === 'wait') await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  }
  try {
    await fn();
  } finally {
    if (held) releaseRepoLock(file, mine);
  }
}

/**
 * `withRepoLock` for synchronous callers (the release pass): `fn` runs while
 * holding the same lock, so a fetch there takes turns with runner
 * allocations in the same repo. It blocks while it waits. A holder in this
 * same process cannot release while this call blocks, so it runs without
 * waiting then. `cwd` is any checkout of the repo.
 */
export function withRepoLockSync<T>(cwd: string, fn: () => T): T {
  let common: string;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fn(); // not a git checkout: nothing to take turns with
  }
  const file = path.join(common, 'lobstah-git.lock');
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies RepoLock);
  const deadline = Date.now() + REPO_LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  while (Date.now() < deadline) {
    const took = takeRepoLock(file, mine);
    if (took.state === 'held') {
      held = true;
      break;
    }
    if (took.state === 'wait') {
      if (took.holder === process.pid) break;
      Atomics.wait(pause, 0, 0, 50 + Math.random() * 50);
    }
  }
  try {
    return fn();
  } finally {
    if (held) releaseRepoLock(file, mine);
  }
}

/**
 * Run `fn` alone in the repo that holds `cwd`: one at a time within this
 * process (a queue) and across processes (withRepoLock). Parallel fetches
 * collide on the repo's ref locks and, on Windows, on the loose objects they
 * unpack; a parallel `git worktree add` can read another's half-written
 * `.git/worktrees/<id>`. `fn` gets the git common dir.
 */
async function oneAtATime(cwd: string, fn: (common: string) => Promise<void>): Promise<void> {
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const key = realpath(common);
  const run = (repoQueues.get(key) ?? Promise.resolve()).then(() => withRepoLock(common, () => fn(common)));
  const tail = run.catch(() => {});
  repoQueues.set(key, tail);
  try {
    await run;
  } finally {
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
  }
}

/** When each `<remote> <ref>` fetch that succeeded last started, in ms. */
function fetchStamps(common: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(path.join(common, 'lobstah-fetch.json'), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * `git fetch <remote> <ref>`, one at a time per repo. A caller that asked
 * before a fetch of the same ref started reuses that fetch instead of
 * fetching again: it would get the same answer.
 */
async function fetchShared(cwd: string, remote: string, ref: string): Promise<void> {
  const asked = Date.now();
  const key = `${remote} ${ref}`;
  await oneAtATime(cwd, async (common) => {
    if ((fetchStamps(common)[key] ?? -Infinity) >= asked) return;
    const started = Date.now();
    await gitShared(cwd, 'fetch', remote, ref);
    const stamps = { ...fetchStamps(common), [key]: started };
    fs.writeFileSync(path.join(common, 'lobstah-fetch.json'), JSON.stringify(stamps, null, 2));
  });
}

/**
 * A fresh worktree for a dispatch, branched from trunk. Never allocate a
 * second one for the same id. (A follow-up may instead reuse its chain's
 * worktree: see chooseWorktree.)
 */
export async function allocate(repo: RepoConfig, id: string, fromRemoteBranch = repo.trunk): Promise<string> {
  const dir = worktreePath(id);
  if (fs.existsSync(dir)) {
    throw new Error(`worktree for ${id} already exists at ${dir} — never allocate a second`);
  }
  if (!fs.existsSync(repo.path)) {
    if (!repo.origin) throw new Error(`repo path ${repo.path} missing and no origin configured`);
    await run('git', ['clone', repo.origin, repo.path], { env: process.env });
  }
  await fetchShared(repo.path, 'origin', fromRemoteBranch);
  // --no-track: an upstream of origin/<trunk> under another branch name is
  // never useful, and writing it takes .git/config's lock, which concurrent
  // allocations contend for too.
  await oneAtATime(repo.path, async () => {
    await gitShared(repo.path, 'worktree', 'add', '--no-track', dir, '-b', `lobstah/${id}`, `origin/${fromRemoteBranch}`);
  });
  await runSetup(repo, dir);
  return dir;
}

/** How `restoreWorktree` brought a trap's checkout back. */
export interface RestoredWorktree {
  dir: string;
  branch: string;
  /** True when the branch was created at the protected ref; false when an existing branch was checked out. */
  createdBranch: boolean;
  /** The remote branch set as upstream, when one exists. */
  upstream?: string;
}

/**
 * Add a trap's checkout back at `dir` from its protected ref. An existing
 * local branch is checked out only when it already contains the ref's
 * commit (it holds the same work or newer); a branch that moved elsewhere
 * refuses rather than being reset. A missing branch is created at the ref,
 * with `origin/<branch>` as its upstream when that exists. The repo's
 * `setup` commands run in the new checkout.
 */
export async function restoreWorktree(repo: RepoConfig, dir: string, opts: { branch: string; ref: string }): Promise<RestoredWorktree> {
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists — a restore never writes over a checkout`);
  const commit = await git(repo.path, 'rev-parse', '--verify', '-q', `${opts.ref}^{commit}`);
  const local = await tryGit(repo.path, 'rev-parse', '--verify', '-q', `refs/heads/${opts.branch}^{commit}`);
  let createdBranch = false;
  await oneAtATime(repo.path, async () => {
    if (local.ok) {
      const contains = await tryGit(repo.path, 'merge-base', '--is-ancestor', commit, `refs/heads/${opts.branch}`);
      if (!contains.ok) {
        throw new Error(`branch ${opts.branch} no longer contains the trap's revision ${commit.slice(0, 12)} — inspect it; a throw never resets a branch`);
      }
      await gitShared(repo.path, 'worktree', 'add', dir, opts.branch);
    } else {
      await gitShared(repo.path, 'worktree', 'add', '--no-track', '-b', opts.branch, dir, commit);
      createdBranch = true;
    }
  });
  let upstream: string | undefined;
  if ((await tryGit(dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).ok === false) {
    const remote = await tryGit(repo.path, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${opts.branch}`);
    if (remote.ok && (await tryGit(dir, 'branch', '--set-upstream-to', `origin/${opts.branch}`)).ok) upstream = `origin/${opts.branch}`;
  }
  await runSetup(repo, dir);
  return { dir, branch: opts.branch, createdBranch, ...(upstream ? { upstream } : {}) };
}

/**
 * Recover an allocation whose dispatch record was lost or never written.
 * The exact dispatch branch in a linked checkout of the configured repo is
 * ownership evidence. A directory name alone is not. Never reset or clean it.
 */
export async function recoverWorktree(repo: RepoConfig, id: string): Promise<string> {
  const dir = worktreePath(id);
  try {
    if (fs.statSync(path.join(dir, '.git')).isFile()) {
      const branch = await git(dir, 'symbolic-ref', '--quiet', 'HEAD');
      const root = await git(dir, 'rev-parse', '--show-toplevel');
      const common = await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const mine = await git(repo.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      if (branch === `refs/heads/lobstah/${id}` && realpath(root) === realpath(dir) && realpath(common) === realpath(mine)) return dir;
    }
  } catch { /* unreadable or non-git paths do not prove ownership */ }
  throw new Error(
    `unrecorded worktree at ${dir} for ${id} — ownership not proven (expected lobstah/${id} in ${repo.path}); ` +
    'inspect and preserve it, then relocate the conflicting checkout before retrying',
  );
}

async function runSetup(repo: RepoConfig, dir: string): Promise<void> {
  for (const cmd of repo.setup ?? []) {
    await shell(cmd, { cwd: dir, env: { ...process.env, ...(repo.env ?? {}) } });
  }
  recordSetup(repo, dir);
}

/**
 * Lockfiles whose change means the repo's `setup` commands (a dependency
 * install) must run again in a reused worktree.
 */
export const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Package.resolved',
];

/** A hash of the setup commands and every lockfile at the worktree's root. */
export function setupHash(repo: RepoConfig, dir: string): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(repo.setup ?? []));
  for (const name of LOCKFILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    h.update(`\0${name}\0`);
    h.update(fs.readFileSync(file));
  }
  return h.digest('hex');
}

function setupRecordFile(dir: string): string | undefined {
  const gitDir = worktreeGitDir(dir);
  return gitDir ? path.join(gitDir, 'lobstah-setup.json') : undefined;
}

/** Record the setup hash in the worktree's git dir, after setup ran. */
function recordSetup(repo: RepoConfig, dir: string): void {
  const file = setupRecordFile(dir);
  if (file) fs.writeFileSync(file, JSON.stringify({ hash: setupHash(repo, dir), at: new Date().toISOString() }, null, 2));
}

function recordedSetupHash(dir: string): string | undefined {
  const file = setupRecordFile(dir);
  try {
    return file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { hash?: string }).hash : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a follow-up reuses its chain's worktree, and why not when it does not. */
export type WorktreeChoice =
  | {
      reuse: true;
      path: string;
      /** The dispatch that allocated the directory. */
      owner: string;
      /** The newest chain member that ran in it. */
      from: string;
    }
  | { reuse: false; reason: string };

export interface ChooseInput {
  /** The follow-up's own id and lane: the lock is taken in its name. */
  id: string;
  lane: Lane;
  /** The repo key the follow-up runs against. */
  repoKey: string;
  repo: RepoConfig;
  /** descriptor.followUp */
  followUp: string;
}

const short = (s: string) => s.slice(0, 8);

/** Canonical path: native realpath (expands Windows 8.3 names), lowercased on Windows. */
function realpath(p: string): string {
  let r: string;
  try {
    r = fs.realpathSync.native(p);
  } catch {
    r = path.resolve(p);
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** A path from `git status --porcelain`, normalized for comparison with scratch paths. */
function norm(p: string): string {
  return p
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** True when every line is an untracked file under a scratch path. */
export function onlyScratch(porcelain: string, scratch: string[] | undefined): boolean {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return true;
  const roots = (scratch ?? []).map(norm).filter(Boolean);
  if (roots.length === 0) return false;
  return lines.every((line) => {
    if (!line.startsWith('?? ')) return false;
    const p = norm(line.slice(3));
    return roots.some((r) => p === r || p.startsWith(`${r}/`));
  });
}

/**
 * Decide whether a follow-up reuses the worktree of the newest dispatch in
 * its chain whose worktree still exists. It reuses only when all hold: the
 * worktree exists, belongs to the same repo, no other active dispatch runs
 * in it, and `git status --porcelain` is clean (untracked files under the
 * repo's `scratch` paths excepted). On reuse the worktree's lock is taken in
 * the follow-up's name, so a second follow-up allocates fresh. A dirty
 * worktree is never cleaned or reset: it is left alone.
 */
export async function chooseWorktree(input: ChooseInput): Promise<WorktreeChoice> {
  const { id, lane, repoKey, repo, followUp } = input;
  const found = chainWorktree(followUp);
  if (!found) return { reuse: false, reason: 'origin worktree is gone' };
  const ownerRepo = storedDescriptor(found.owner, laneOf(found.owner) ?? lane)?.repo ?? storedDescriptor(found.from, laneOf(found.from) ?? lane)?.repo;
  if (ownerRepo !== undefined && ownerRepo !== repoKey) {
    return { reuse: false, reason: `origin worktree belongs to repo ${ownerRepo}` };
  }
  try {
    const common = await git(found.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const mine = await git(repo.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (realpath(common) !== realpath(mine)) return { reuse: false, reason: 'origin worktree belongs to another repo' };
  } catch {
    return { reuse: false, reason: 'origin worktree is not a readable git checkout' };
  }
  const here = realpath(found.path);
  // A trap works in its own checkout; lobstah never reuses one, even one a
  // trap anchored inside a dispatch's worktree.
  for (const t of listTraps()) {
    if (typeof t.worktree !== 'string') continue;
    const rel = path.relative(here, realpath(t.worktree));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { reuse: false, reason: 'origin worktree is a trap’s' };
  }
  for (const l of ['work', 'chore'] as Lane[]) {
    for (const other of activeIds(l)) {
      if (other === id) continue;
      if (realpath(dispatchWorktree(other, l).path) === here) {
        return { reuse: false, reason: `origin worktree is in use by ${short(other)}` };
      }
    }
  }
  const holder = worktreeHolder(found.path);
  if (holder && holder.id !== id) return { reuse: false, reason: `origin worktree is in use by ${short(holder.id)}` };
  let porcelain: string;
  try {
    porcelain = await git(found.path, 'status', '--porcelain');
  } catch {
    return { reuse: false, reason: 'origin worktree is not a readable git checkout' };
  }
  if (!onlyScratch(porcelain, repo.scratch)) {
    return { reuse: false, reason: 'origin worktree has uncommitted changes; allocated a fresh one' };
  }
  const held = acquireWorktreeLock(found.path, id, lane);
  if (held) return { reuse: false, reason: `origin worktree is in use by ${short(held.id)}` };
  return { reuse: true, path: found.path, owner: found.owner, from: found.from };
}

/**
 * Ready a reused worktree: fetch trunk, and run the repo's `setup` commands
 * again only when a lockfile (or the commands) changed since they last ran
 * there. The checked-out branch and HEAD are left alone. Returns whether
 * setup ran.
 */
export async function prepareReuse(repo: RepoConfig, dir: string): Promise<{ setupRan: boolean }> {
  await fetchShared(dir, 'origin', repo.trunk);
  if (!(repo.setup?.length)) return { setupRan: false };
  if (recordedSetupHash(dir) === setupHash(repo, dir)) return { setupRan: false };
  await runSetup(repo, dir);
  return { setupRan: true };
}

export async function collectEvidence(repo: RepoConfig, dir: string): Promise<{ branch: string; commits: string[] }> {
  const branch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const log = await git(dir, 'log', '--oneline', `origin/${repo.trunk}..HEAD`);
  return { branch, commits: log ? log.split('\n') : [] };
}

/** Remove the worktree a dispatch allocated (its own `worktrees/<id>`). */
export async function remove(repo: RepoConfig, id: string): Promise<void> {
  const dir = worktreePath(id);
  if (!fs.existsSync(dir)) return;
  await git(repo.path, 'worktree', 'remove', '--force', dir);
}

/** git that never throws: exit status and trimmed output. */
async function tryGit(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, env: process.env });
    return { ok: true, out: stdout.trimEnd(), err: stderr.trim() };
  } catch (e) {
    return { ok: false, out: ((e as { stdout?: string }).stdout ?? '').trim(), err: gitStderr(e) };
  }
}

/**
 * Undo a worktree that `allocate` left half made (its setup failed): remove
 * the checkout, prune git's record of it, and delete the branch allocate
 * created. Only for a worktree lobstah itself just created: it forces.
 */
export async function discard(repo: RepoConfig, dir: string, branch: string): Promise<void> {
  await tryGit(repo.path, 'worktree', 'remove', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  await tryGit(repo.path, 'worktree', 'prune');
  await tryGit(repo.path, 'branch', '-D', branch);
}

/** What `removeIfSafe` did with a worktree. */
export type SafeRemoval =
  | {
      removed: true;
      /** The primary checkout the removal ran from. */
      primary: string;
      /** Branches deleted because they held nothing unique. */
      deletedBranches: string[];
      /** Branches kept, each with its reason. */
      keptBranches: Array<{ branch: string; reason: string }>;
    }
  | { removed: false; reason: string; primary?: string };

/** Commits reachable from `ref` that no ref in `exclude` (or no remote, when empty) reaches. */
async function uniqueCommits(cwd: string, ref: string, exclude?: string): Promise<number | undefined> {
  const res = exclude
    ? await tryGit(cwd, 'rev-list', '--count', ref, '--not', exclude)
    : await tryGit(cwd, 'rev-list', '--count', ref, '--not', '--remotes');
  return res.ok ? Number(res.out) : undefined;
}

/**
 * Remove a worktree only when it holds no work that exists nowhere else: no
 * uncommitted changes, no untracked files that are not ignored, and no
 * commit that its upstream lacks (or a branch without an upstream).
 * Only an explicit `force` bypasses these checks. Paths in `ignore`
 * (relative to the worktree root, e.g. lobstah's own anchor file) do not
 * count as untracked work; they are deleted before the removal and put back
 * when it fails.
 *
 * The removal runs from the primary checkout, and this process leaves the
 * worktree first when it stands inside it. Afterwards each branch in
 * `branches` (and the branch the worktree had checked out) is deleted when
 * it has no commit that is not on its upstream (without an upstream: on any
 * remote branch), and kept otherwise.
 */
export async function removeIfSafe(dir: string, opts: { ignore?: string[]; branches?: string[]; force?: boolean } = {}): Promise<SafeRemoval> {
  if (!fs.existsSync(dir)) return { removed: false, reason: 'the worktree is already gone' };
  const common = await tryGit(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common.ok || !common.out) return { removed: false, reason: 'not a readable git checkout' };
  const commonDir = path.resolve(common.out);
  const primary = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const ignore = new Set((opts.ignore ?? []).map((p) => p.replace(/\\/g, '/')));

  const status = await tryGit(dir, 'status', '--porcelain', '--untracked-files=all');
  if (!status.ok) return { removed: false, reason: `git status failed: ${status.err}`, primary };
  const lines = status.out.split('\n').filter((l) => l.trim() !== '');
  const untracked = lines.filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
  const changed = lines.filter((l) => !l.startsWith('?? '));
  const strayUntracked = untracked.filter((p) => !ignore.has(p));
  const list = (paths: string[]) => paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, and ${paths.length - 3} more` : '');
  if (!opts.force && changed.length > 0) {
    const paths = changed.map((l) => l.slice(3));
    return { removed: false, reason: `uncommitted changes in ${changed.length} file(s): ${list(paths)}`, primary };
  }
  if (!opts.force && strayUntracked.length > 0) {
    return { removed: false, reason: `${strayUntracked.length} untracked file(s) that are not ignored: ${list(strayUntracked)}`, primary };
  }
  const unpushed = await uniqueCommits(dir, 'HEAD');
  if (!opts.force && unpushed === undefined) return { removed: false, reason: 'cannot tell which commits are on a remote', primary };
  if (!opts.force && unpushed! > 0) return { removed: false, reason: `${unpushed} commit(s) on no remote branch`, primary };
  if (!opts.force) {
    const safety = inspectTrapWorktree(dir);
    if (safety.reason) return { removed: false, reason: safety.reason, primary };
  }

  const head = await tryGit(dir, 'symbolic-ref', '--short', '-q', 'HEAD');
  const branches = [...new Set([...(head.ok && head.out ? [head.out] : []), ...(opts.branches ?? [])])];

  // Our own files go first (git refuses untracked files without --force),
  // and come back if the removal fails.
  const saved = new Map<string, Buffer>();
  for (const rel of ignore) {
    const file = path.join(dir, rel);
    try {
      saved.set(file, fs.readFileSync(file));
      fs.rmSync(file, { force: true });
    } catch {
      // not there
    }
  }
  // A process cannot remove the directory it stands in on every platform.
  const real = (p: string) => {
    try {
      const r = fs.realpathSync.native(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(dir), real(process.cwd()));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) process.chdir(primary);
  const removed = await tryGit(primary, '--git-dir', commonDir, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), dir);
  if (!removed.ok) {
    if (fs.existsSync(dir)) for (const [file, content] of saved) fs.writeFileSync(file, content);
    return { removed: false, reason: `git worktree remove refused: ${removed.err}`, primary };
  }

  const deletedBranches: string[] = [];
  const keptBranches: Array<{ branch: string; reason: string }> = [];
  for (const branch of branches) {
    const exists = await tryGit(primary, '--git-dir', commonDir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    if (!exists.ok) continue;
    const upstream = await tryGit(primary, '--git-dir', commonDir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`);
    const unique = await uniqueCommits(primary, `refs/heads/${branch}`, upstream.ok && upstream.out ? upstream.out : undefined);
    if (unique === undefined) {
      keptBranches.push({ branch, reason: 'cannot tell which commits are unique' });
    } else if (unique > 0) {
      keptBranches.push({ branch, reason: `${unique} commit(s) not on ${upstream.ok && upstream.out ? upstream.out : 'any remote branch'}` });
    } else {
      const del = await tryGit(primary, '--git-dir', commonDir, 'branch', '-D', branch);
      if (del.ok) deletedBranches.push(branch);
      else keptBranches.push({ branch, reason: del.err });
    }
  }
  return { removed: true, primary, deletedBranches, keptBranches };
}
