import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendStatus, claimNext, enqueue, ensureLayout, GB, laneDirs, prRecordFile, statusPath, readRecordArchive } from '@lobstah/core';
import { cliCuller } from '../src/auto-cull.js';
import { applyCull, planCull, planPressureCull, runCull, sizing } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { writeAck } from '../src/acks.js';

let home: string;
let repo: string;
const DAY = 86_400_000;

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A finished work dispatch with a real git worktree on branch lobstah/<id>. */
function finished(id: string, days: number, verb: 'done' | 'failed' = 'done', lane: 'work' | 'chore' = 'work'): string {
  const wt = path.join(home, 'worktrees', id);
  git(repo, 'worktree', 'add', '-q', '-b', `lobstah/${id}`, wt);
  const done = path.join(laneDirs(lane).done, id);
  fs.mkdirSync(done);
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'r', brief: 'b' }));
  appendStatus(id, lane, verb, 'finished');
  age(statusPath(id, lane), days);
  age(wt, days);
  age(done, days);
  return wt;
}

function openPr(id: string, n: number): void {
  const key = `pr:o/r#${n}`;
  fs.mkdirSync(path.dirname(prRecordFile(key)), { recursive: true });
  fs.writeFileSync(
    prRecordFile(key),
    JSON.stringify({ key, repo: 'o/r', url: `https://github.com/o/r/pull/${n}`, number: n, state: 'OPEN', dispatches: [id], observedAt: new Date().toISOString() }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-autocull-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = "${repo.replace(/\\/g, '/')}"\ntrunk = "main"\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('retention cull (the daemon culler)', () => {
  beforeEach(() => fs.appendFileSync(path.join(home, 'config.toml'), '[limits]\nrecordRetentionDays = 3\n'));
  it('culls an old review chore and retains one inside the configured window', () => {
    const old = finished('old-review', 4, 'done', 'chore');
    const recent = finished('recent-review', 2, 'done', 'chore');
    expect(cliCuller.retention(3, Date.now(), () => {})).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(statusPath('old-review', 'chore'))).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('chore').done, 'recent-review'))).toBe(true);
  });

  it('removes worktrees before an older ack backlog, keeping each dispatch group together', () => {
    const old = finished('old-checkout', 20);
    const newer = finished('newer-checkout', 10);
    for (let i = 0; i < 15; i++) {
      writeAck({ key: `decision:gone-${i}`, kind: 'decision', stateHash: 'x', at: new Date(Date.now() - 40 * DAY).toISOString(), by: 'test' });
    }
    writeAck({ key: 'work:old-checkout', kind: 'landed', stateHash: 'x', at: new Date(Date.now() - 40 * DAY).toISOString(), by: 'test' });
    const order: string[] = [];
    const remove = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
      if (String(target).includes(`${path.sep}acks${path.sep}`)) {
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(newer)).toBe(false);
        order.push('ack');
      }
      return remove(target, options);
    }) as typeof fs.rmSync);
    syncBuiltinESMExports();
    expect(cliCuller.retention(3, Date.now(), () => {})).toBe(2);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'old-checkout'))).toBe(false);
    expect(fs.existsSync(statusPath('old-checkout', 'work'))).toBe(false);
    expect(fs.readdirSync(path.join(home, 'acks'))).toHaveLength(0);
    expect(order).toHaveLength(16);
  });

  it('removes a finished dispatch, its worktree, and its state, and keeps its branch', () => {
    const wt = finished('old-done', 20);
    const failedWt = finished('old-failed', 20, 'failed');
    const n = cliCuller.retention(14, Date.now(), () => {});
    expect(n).toBe(2);
    for (const [id, dir] of [['old-done', wt], ['old-failed', failedWt]] as const) {
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(path.join(laneDirs('work').done, id))).toBe(false);
      expect(fs.existsSync(statusPath(id, 'work'))).toBe(false);
      expect(git(repo, 'branch', '--list', `lobstah/${id}`)).toContain(`lobstah/${id}`);
    }
  });

  it('keeps a finished dispatch younger than the window', () => {
    const wt = finished('fresh', 2);
    expect(cliCuller.retention(14, Date.now(), () => {})).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('skips a dispatch whose PR record is still open', () => {
    const wt = finished('pr-open', 30);
    openPr('pr-open', 7);
    expect(cliCuller.retention(14, Date.now(), () => {})).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'pr-open'))).toBe(true);
    expect(fs.existsSync(statusPath('pr-open', 'work'))).toBe(true);
  });

  it('skips a dispatch whose own evidence says its PR is open', () => {
    const wt = finished('ev-open', 30);
    fs.writeFileSync(
      path.join(laneDirs('work').state, 'ev-open.evidence'),
      JSON.stringify({ prUrl: 'https://github.com/o/r/pull/9', pr: { url: 'https://github.com/o/r/pull/9', number: 9, state: 'OPEN', observedAt: new Date().toISOString() } }),
    );
    expect(cliCuller.retention(14, Date.now(), () => {})).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('never culls active or queued dispatches, however old', () => {
    enqueue({ id: 'x1', repo: 'r', brief: 'b' });
    enqueue({ id: 'x2', repo: 'r', brief: 'b' });
    const active = claimNext('work')!;
    const queued = active === 'x1' ? 'x2' : 'x1';
    for (const id of [active, queued]) {
      const wt = path.join(home, 'worktrees', id);
      fs.mkdirSync(wt);
      age(wt, 60);
    }
    age(path.join(laneDirs('work').queue, `${queued}.json`), 60);
    age(path.join(laneDirs('work').active, active), 60);
    expect(cliCuller.retention(14, Date.now(), () => {})).toBe(0);
    expect(fs.existsSync(path.join(home, 'worktrees', active))).toBe(true);
    expect(fs.existsSync(path.join(home, 'worktrees', queued))).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').queue, `${queued}.json`))).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').active, active))).toBe(true);
  });

  it('clears a backlog larger than ten worktrees in one pass', () => {
    const dirs = Array.from({ length: 25 }, (_, i) => finished(`backlog-${i}`, 20));
    expect(cliCuller.retention(14, Date.now(), () => {})).toBe(25);
    for (const dir of dirs) expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(laneDirs('work').done)).toHaveLength(0);
  });

  it('keeps a checkout claimed by a follow-up after the background plan was made', () => {
    const wt = finished('origin', 20);
    const plan = planCull(3, Date.now(), { measure: false, keepOpenPrs: true });
    enqueue({ id: 'followup', repo: 'r', brief: 'continue', followUp: 'origin' });
    applyCull(plan);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'origin'))).toBe(true);
    expect(fs.existsSync(statusPath('origin', 'work'))).toBe(true);
  });

  it('keeps dirty or unpushed review checkouts and their records in later culls', () => {
    const dirs = ['dirty-review', 'unpushed-review'].map((id) => {
      const wt = finished(id, 20, 'done', 'chore');
      const file = path.join(laneDirs('chore').done, id, 'descriptor.json');
      fs.writeFileSync(file, JSON.stringify({ id, repo: 'r', brief: 'review', readOnly: true }));
      age(path.dirname(file), 20);
      return wt;
    });
    fs.writeFileSync(path.join(dirs[0]!, 'local.txt'), 'unsaved');
    // No remote contains this repo's initial commit, so the other checkout is unpushed.
    expect(planPressureCull()).toEqual([]);
    expect(cliCuller.retention(1, Date.now(), () => {})).toBe(0);
    for (const id of ['dirty-review', 'unpushed-review']) {
      expect(fs.existsSync(path.join(laneDirs('chore').done, id))).toBe(true);
      expect(fs.existsSync(statusPath(id, 'chore'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'worktrees', id))).toBe(true);
    }
  });

  it('keeps newly dirty review work after a background plan was made', () => {
    const wt = finished('review', 20, 'done', 'chore');
    const origin = path.join(home, 'origin.git');
    git(repo, 'clone', '-q', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '-q', 'origin');
    const done = path.join(laneDirs('chore').done, 'review');
    fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: 'review', repo: 'r', brief: 'review', readOnly: true }));
    age(done, 20);
    const plan = planCull(1, Date.now(), { measure: false });
    expect(plan.some((item) => item.kind === 'worktree')).toBe(true);
    fs.writeFileSync(path.join(wt, 'new-findings.txt'), 'keep');
    applyCull(plan);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(done)).toBe(true);
    expect(fs.existsSync(statusPath('review', 'chore'))).toBe(true);
  });

  it('makes no size calls', () => {
    finished('unsized', 20);
    const walk = vi.spyOn(sizing, 'walk');
    const worktree = vi.spyOn(sizing, 'worktree');
    cliCuller.retention(14, Date.now(), () => {});
    expect(walk).not.toHaveBeenCalled();
    expect(worktree).not.toHaveBeenCalled();
  });
});

describe('pressure cull (the free-space guard)', () => {
  it('removes finished worktrees oldest first until there is enough, and keeps records and branches', () => {
    const oldest = finished('p-old', 3);
    const newer = finished('p-new', 1);
    let free = 1 * GB;
    const removed = cliCuller.pressure(() => free >= 5 * GB, Date.now(), () => {
      free += 5 * GB;
    });
    expect(removed).toBe(1);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'p-old'))).toBe(true);
    expect(git(repo, 'branch', '--list', 'lobstah/p-old')).toContain('lobstah/p-old');
  });

  it('ignores the retention window but never takes live or open-PR worktrees', () => {
    finished('fresh-done', 0);
    finished('open', 5);
    openPr('open', 3);
    enqueue({ id: 'live', repo: 'r', brief: 'b' });
    fs.mkdirSync(path.join(home, 'worktrees', 'live'));
    expect(planPressureCull().map((i) => i.id)).toEqual(['fresh-done']);
  });

  it('never takes a worktree a soaking trap works in, and neither does the retention cull', () => {
    const wt = finished('soaked', 30);
    fs.writeFileSync(
      path.join(home, 'soaking', 'trap1.json'),
      JSON.stringify({ trapId: 'trap1', sessionId: 's1', worktree: wt, heartbeatAt: new Date().toISOString() }),
    );
    expect(planPressureCull()).toEqual([]);
    cliCuller.retention(14, Date.now(), () => {});
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe('lobstah cull sizing', () => {
  it('--apply makes zero size calls and reports the free-space change', () => {
    finished('apply1', 20);
    const walk = vi.spyOn(sizing, 'walk');
    const worktree = vi.spyOn(sizing, 'worktree');
    let free = 2 * GB;
    const out = runCull(14, true, () => {
      const v = free;
      free += 3 * GB;
      return v;
    });
    expect(walk).not.toHaveBeenCalled();
    expect(worktree).not.toHaveBeenCalled();
    expect(out).toMatch(/applied: \d+ removed, 3 GB freed/);
    expect(out).not.toMatch(/bytes/);
    expect(fs.existsSync(path.join(home, 'worktrees', 'apply1'))).toBe(false);
  });

  it('the dry run measures a worktree once with du, and deletes nothing', () => {
    const wt = finished('dry1', 20);
    fs.writeFileSync(path.join(wt, 'big.bin'), Buffer.alloc(64 * 1024));
    const worktree = vi.spyOn(sizing, 'worktree');
    const out = runCull(14, false, () => 0);
    expect(worktree).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/dry run/);
    const item = planCull(14).find((i) => i.kind === 'worktree');
    expect(item?.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('falls back to the JS walk where du is missing (Windows)', () => {
    const dir = path.join(home, 'sized');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a'), 'hello');
    fs.writeFileSync(path.join(dir, 'sub', 'b'), 'world!!');
    expect(sizing.worktree(dir, 'win32')).toBe(12);
    expect(sizing.worktree(dir, 'win32')).toBe(sizing.walk(dir));
  });
});

describe('separate worktree and record windows', () => {
  it.each(['work', 'chore'] as const)('removes a two-day %s checkout and keeps its history for thirty days by default', (lane) => {
    const wt = finished('recent-record', 2, 'done', lane);
    fs.appendFileSync(path.join(home, 'config.toml'), '[limits]\nchoreRetentionDays = 1\nrunRetentionDays = 1\n');
    cliCuller.retention(1, Date.now(), () => {});
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(path.join(laneDirs(lane).done, 'recent-record'))).toBe(true);
    expect(fs.existsSync(statusPath('recent-record', lane))).toBe(true);
    expect(readRecordArchive(`${lane}:recent-record`)).toBeUndefined();
  });

  it('archives records after thirty days even when worktree retention is off', () => {
    const wt = finished('archive-me', 31);
    const note = path.join(laneDirs('work').state, 'archive-me.notes');
    fs.writeFileSync(note, 'Keep these notes');
    cliCuller.retention(0, Date.now(), () => {});
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'archive-me'))).toBe(false);
    expect(fs.existsSync(note)).toBe(false);
    const receipt = readRecordArchive('work:archive-me')!;
    expect(receipt.paths).toContain(path.join('state', 'archive-me.notes'));
    const restored = execFileSync('tar', ['-xOzf', path.join(home, 'archive', receipt.bundle), 'state/archive-me.notes'], { encoding: 'utf8' });
    expect(restored).toBe('Keep these notes');
  });

  it('supports a configurable record window and zero to keep records online', () => {
    fs.appendFileSync(path.join(home, 'config.toml'), '[limits]\nrecordRetentionDays = 0\n');
    finished('keep-record', 100);
    cliCuller.retention(1, Date.now(), () => {});
    expect(fs.existsSync(statusPath('keep-record', 'work'))).toBe(true);
    const config = path.join(home, 'config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('recordRetentionDays = 0', 'recordRetentionDays = 90'));
    cliCuller.retention(1, Date.now(), () => {});
    expect(fs.existsSync(statusPath('keep-record', 'work'))).toBe(false);
    expect(readRecordArchive('work:keep-record')).toBeDefined();
  });

  it('keeps online records if archival fails', () => {
    finished('archive-failed', 31);
    fs.writeFileSync(path.join(home, 'archive'), 'cannot create an archive directory');
    expect(() => cliCuller.retention(1, Date.now(), () => {})).toThrow();
    expect(fs.existsSync(path.join(laneDirs('work').done, 'archive-failed'))).toBe(true);
    expect(fs.existsSync(statusPath('archive-failed', 'work'))).toBe(true);
  });
});
