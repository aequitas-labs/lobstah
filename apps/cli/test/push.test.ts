import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  addWatch,
  appendStatus,
  ensureLayout,
  laneDirs,
  listNotices,
  mergeEvidence,
  readEvidence,
  readPr,
  readStatusLog,
  repairBrief,
  upsertPr,
} from '@lobstah/core';
import type { Descriptor, PrEvidence } from '@lobstah/core';
import { deliverPrRepairs } from '../src/pr-repair.js';
import { runPush } from '../src/push.js';
import { rebaseBrief } from '../../pick/src/loops/merge.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const URL = 'https://github.com/acme/web/pull/17';
const KEY = 'pr:acme/web#17';
let root: string;
let previousPath: string | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(dir: string, file: string, text: string): string {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

function checkout(bare: string, dir: string, name: string): void {
  git(root, 'clone', '-q', bare, dir);
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.test`);
}

function fixture(): { bare: string; worker: string; rival: string } {
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  checkout(bare, seed, 'Seed');
  commit(seed, 'README.md', 'start\n');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feature/pr');
  commit(seed, 'feature.txt', 'feature\n');
  git(seed, 'push', '-q', 'origin', 'feature/pr');
  const worker = path.join(root, 'worker');
  const rival = path.join(root, 'rival');
  checkout(bare, worker, 'Worker');
  checkout(bare, rival, 'Rival');
  git(worker, 'switch', '-q', 'feature/pr');
  git(rival, 'switch', '-q', 'feature/pr');
  return { bare, worker, rival };
}

function race(rival: string, n: number): string {
  git(rival, 'pull', '-q', '--rebase', 'origin', 'feature/pr');
  commit(rival, `rival-${n}.txt`, `rival ${n}\n`);
  git(rival, 'push', '-q', 'origin', 'feature/pr');
  return git(rival, 'rev-parse', 'HEAD');
}

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: URL,
  number: 17,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'DIRTY',
  headSha: SHA,
  baseRefName: 'main',
  headRefName: 'feature/pr',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: new Date().toISOString(),
  ...over,
});

function queued(): Descriptor[] {
  return fs
    .readdirSync(laneDirs('work').queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as Descriptor);
}

/** A dispatch-owned PR with one conflict repair queued: the repair's descriptor. */
function queuedRepair(): Descriptor {
  const done = path.join(laneDirs('work').done, OWNER);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: OWNER, repo: 'web', brief: 'make PR' } satisfies Descriptor));
  appendStatus(OWNER, 'work', 'done', 'PR sent');
  mergeEvidence(OWNER, 'work', { commits: [SHA] });
  addWatch(KEY, 'echo {}', { owner: `dispatch:${OWNER}` });
  upsertPr(pr(), OWNER);
  upsertPr(pr(), OWNER);
  expect(deliverPrRepairs(() => {}, 3)).toBe(1);
  return queued()[0]!;
}

/** A gh on PATH that records every call. */
function recordGh(): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(root, 'gh-calls');
  const gh = path.join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh');
  if (process.platform === 'win32') fs.writeFileSync(gh, `@echo off\r\necho %* >> "${calls}"\r\nexit /b 1\r\n`);
  else {
    fs.writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexit 1\n`);
    fs.chmodSync(gh, 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  return calls;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-push-'));
  previousPath = process.env.PATH;
  process.env.LOBSTAH_HOME = path.join(root, 'home');
  ensureLayout();
  fs.writeFileSync(path.join(root, 'home', 'config.toml'), '[watch]\nrepairSettleSecs = 0\n');
});
afterEach(() => {
  process.env.PATH = previousPath;
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('lobstah push', { timeout: 60_000 }, () => {
  it('pushes a repair to its PR branch after one rejection and records the push', () => {
    const { bare, worker, rival } = fixture();
    const repair = queuedRepair();
    commit(worker, 'fix.txt', 'fix\n');
    const out = runPush(repair.id, 'work', { cwd: worker, beforeAttempt: (n) => { if (n === 1) race(rival, n); } });
    expect(out.result).toMatchObject({ kind: 'pushed', branch: 'feature/pr', attempts: 2 });
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(git(worker, 'rev-parse', 'HEAD'));
    expect(readEvidence(repair.id, 'work').pushes?.map((p) => p.branch)).toEqual(['feature/pr']);
    expect(readStatusLog(repair.id, 'work').map((e) => e.verb)).not.toContain('failed');
  });

  it('a push rejected on every retry fails the dispatch loudly: no new branch, no new PR, PR record marked, helm notice', () => {
    const { bare, worker, rival } = fixture();
    const calls = recordGh();
    fs.appendFileSync(path.join(root, 'home', 'config.toml'), 'pushRetries = 2\n');
    const repair = queuedRepair();
    commit(worker, 'fix.txt', 'fix\n');
    let moved = '';
    let attempts = 0;
    const out = runPush(repair.id, 'work', { cwd: worker, beforeAttempt: (n) => { attempts = n; moved = race(rival, n); } });
    expect(attempts).toBe(3);
    expect(out.result).toMatchObject({ kind: 'failed', attempts: 3, movedHead: moved });

    const last = readStatusLog(repair.id, 'work').at(-1)!;
    expect(last.verb).toBe('failed');
    expect(last.note).toContain(`moved head ${moved.slice(0, 12)}`);
    expect(last.note).toMatch(/rejected.*stale info|stale info.*rejected/);

    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort()).toEqual(['refs/heads/feature/pr', 'refs/heads/main']);
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(moved);
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').toBe('');

    expect(readPr(KEY)?.repair).toMatchObject({ status: 'blocked', headSha: moved, fromHeadSha: SHA, dispatchId: repair.id });
    expect(listNotices().filter((n) => n.kind === 'push-failed').map((n) => n.refId)).toEqual([repair.id]);

    // No new round on the head it started from, nor on the moved head once observed.
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    upsertPr(pr({ headSha: moved }), OWNER);
    upsertPr(pr({ headSha: moved }), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    expect(queued().map((d) => d.id)).toEqual([repair.id]);
  });

  it('a hook failure that is a real error is not retried and does not fail the dispatch', () => {
    const { bare, worker } = fixture();
    const repair = queuedRepair();
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\necho "test failed: expected 1, got 2"\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
    git(worker, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
    const before = git(bare, 'rev-parse', 'refs/heads/feature/pr');
    commit(worker, 'fix.txt', 'fix\n');
    let attempts = 0;
    const out = runPush(repair.id, 'work', { cwd: worker, beforeAttempt: () => attempts++ });
    expect(out.result).toMatchObject({ kind: 'refused', attempts: 1 });
    expect(attempts).toBe(1);
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(before);
    expect(readStatusLog(repair.id, 'work').map((e) => e.verb)).not.toContain('failed');
    expect(listNotices().filter((n) => n.kind === 'push-failed')).toEqual([]);
  });

  it('refuses a dispatch with no existing PR', () => {
    fixture();
    const id = '22222222-2222-2222-2222-222222222222';
    const done = path.join(laneDirs('work').done, id);
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief: 'new work' } satisfies Descriptor));
    expect(() => runPush(id, 'work', { cwd: path.join(root, 'worker') })).toThrow(/no existing PR/);
  });
});

describe('the push rule in briefs', () => {
  it('the repair brief and the rebase brief tell the worker to push to the existing branch, fetch and replay, and never open a branch or PR', () => {
    upsertPr(pr(), OWNER);
    const rule = [
      'Push only to the existing branch feature/pr, with `lobstah push',
      'fetches feature/pr, replays your commits onto the moved head',
      'Never push to another branch. Never open a new PR.',
    ];
    for (const kind of ['conflict', 'checks', 'review'] as const) {
      const brief = repairBrief(readPr(KEY)!, kind);
      for (const line of rule) expect(brief).toContain(line);
    }
    const rebase = rebaseBrief(
      { number: 17, url: URL, headRef: 'feature/pr', headSha: SHA, labels: [], assignees: [], reviews: [], mergeableState: 'dirty' } as never,
      'chore-id',
    );
    for (const line of rule) expect(rebase).toContain(line);
    expect(rebase).toContain('lobstah push chore-id');
  });
});
