import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendStatus, claimNext, complete, dispatchAttachmentsDir, enqueue, ensureLayout } from '@lobstah/core';
import { applyCull, planCull, planPressureCull } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const DAY = 86_400_000;

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A real orphan, published to a local bare remote, with no dispatch record or upstream. */
function orphan(id: string, days: number): string {
  const repo = path.join(home, 'repo');
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const remote = path.join(home, 'remote.git');
    git(home, 'clone', '-q', '--bare', repo, remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'fetch', '-q', 'origin');
  }
  const wt = path.join(home, 'worktrees', id);
  git(repo, 'worktree', 'add', '-q', '-b', id, wt);
  age(wt, days);
  return wt;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cull-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('planCull', () => {
  it('flags old done entries and keeps recent ones', () => {
    for (const [id, days] of [['old1', 20], ['fresh1', 2]] as const) {
      fs.mkdirSync(path.join(home, 'done', id));
      age(path.join(home, 'done', id), days);
    }
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['done:old1']);
  });

  it('flags orphaned worktrees but never live or recently-done ones', () => {
    fs.mkdirSync(path.join(home, 'worktrees', 'live1'), { recursive: true });
    fs.mkdirSync(path.join(home, 'active', 'live1'));
    fs.mkdirSync(path.join(home, 'worktrees', 'recent1'));
    fs.mkdirSync(path.join(home, 'done', 'recent1'));
    orphan('ghost1', 30);
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['worktree:ghost1']);
  });

  it('applies the age cutoff to orphans, including its boundary, while pressure can take a recent published one', () => {
    const wt = orphan('recent-orphan', 1);
    expect(planCull(3, Date.now(), { measure: false })).toEqual([]);
    const modified = fs.statSync(wt).mtimeMs;
    expect(planCull(3, modified + 3 * DAY, { measure: false })).toEqual([]);
    expect(planCull(3, modified + 3 * DAY + 1, { measure: false }).map((i) => i.id)).toEqual(['recent-orphan']);
    expect(planPressureCull().map((i) => i.id)).toEqual(['recent-orphan']);
  });

  it('keeps dirty, unpublished, and unreadable orphans in retention and pressure passes', () => {
    const dirty = orphan('dirty-orphan', 30);
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'keep this');
    age(dirty, 30);
    const unpublished = orphan('unpublished-orphan', 30);
    git(unpublished, 'commit', '-q', '--allow-empty', '-m', 'local work');
    const unreadable = path.join(home, 'worktrees', 'not-a-checkout');
    fs.mkdirSync(unreadable);
    age(unreadable, 30);
    expect(planCull(3, Date.now(), { measure: false })).toEqual([]);
    expect(planPressureCull()).toEqual([]);
    for (const wt of [dirty, unpublished, unreadable]) expect(fs.existsSync(wt)).toBe(true);
  });

  it('removes only an old published orphan and keeps its branch', () => {
    const wt = orphan('published-orphan', 30);
    applyCull(planCull(3, Date.now(), { measure: false }));
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(path.join(home, 'repo'), 'branch', '--list', 'published-orphan')).toContain('published-orphan');
  });

  it('flags stale state for ids nothing knows, keeps state of known dispatches', () => {
    enqueue({ id: 'queued1', repo: 'r', brief: 'b' });
    appendStatus('queued1', 'work', 'working');
    appendStatus('lost1', 'work', 'failed');
    age(path.join(home, 'state', 'lost1.status'), 30);
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['state:lost1']);
  });

  it('never touches queue or active regardless of age', () => {
    enqueue({ id: 'q1', repo: 'r', brief: 'b' });
    age(path.join(home, 'queue', 'q1.json'), 60);
    fs.mkdirSync(path.join(home, 'active', 'a1'));
    age(path.join(home, 'active', 'a1'), 60);
    expect(planCull(14)).toEqual([]);
  });

  it('counts attachment bytes in the dry run and removes them with old state', () => {
    const done = path.join(home, 'done', 'old2');
    const attachments = dispatchAttachmentsDir('old2', 'work');
    fs.mkdirSync(done);
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(attachments, 'note.txt'), 'five!');
    age(done, 30);
    const plan = planCull(14);
    expect(plan.map((item) => `${item.kind}:${item.id}`)).toEqual(['done:old2', 'state:old2']);
    expect(plan.find((item) => item.kind === 'state')?.bytes).toBe(5);
    applyCull(plan);
    expect(fs.existsSync(attachments)).toBe(false);
    expect(fs.existsSync(done)).toBe(false);
  });

  it('keeps an old origin attachment while a live follow-up still references it', () => {
    const attachments = dispatchAttachmentsDir('origin', 'work');
    fs.mkdirSync(attachments, { recursive: true });
    const file = path.join(attachments, 'spec.txt');
    fs.writeFileSync(file, 'keep me');
    enqueue({ id: 'origin', repo: 'r', brief: 'first', attachments: [{ name: 'spec.txt', path: file, bytes: 7, type: 'text/plain' }] });
    claimNext('work');
    complete('origin', 'work');
    age(path.join(home, 'done', 'origin'), 30);
    enqueue({ id: 'child', repo: 'r', brief: 'next', followUp: 'origin' });
    const plan = planCull(14);
    expect(plan.map((item) => `${item.kind}:${item.id}`)).toContain('done:origin');
    expect(plan.map((item) => `${item.kind}:${item.id}`)).not.toContain('state:origin');
    applyCull(plan);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
  });
});
