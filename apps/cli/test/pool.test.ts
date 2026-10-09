import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  claimBait,
  daemonSkip,
  enqueue,
  ensureLayout,
  laneDirs,
  poolSlotPath,
  queuedDescriptor,
  signOnTrap,
  writeSlotMeta,
  writeSlotOut,
} from '@lobstah/core';
import { poolPass } from '@lobstah/supervisor';
import { applyCull, planCull, planPressureCull } from '../src/cull.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Pools as the CLI and daemon see them: cull leaves them alone, tend shows
 * them, the daemon starts warm-ups, and traps never take pool work. No git:
 * a slot is a directory with a `.git` file pointing at its git dir, which is
 * all the lock and the views read.
 */

let home: string;
const DAY = 86_400_000;

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

function config(size = 3): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    ['[repos.r]', `path = ${JSON.stringify(path.join(home, 'repo'))}`, '[pools.p]', 'repo = "r"', `size = ${size}`, 'overflow = "queue"'].join('\n'),
  );
}

/** A fake ready slot: a checkout dir whose `.git` file points at a git dir. */
function slot(n: number): string {
  const dir = poolSlotPath('p', n);
  const gitDir = path.join(home, 'gitdirs', String(n));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
  writeSlotMeta('p', n, { readyAt: new Date().toISOString() });
  return dir;
}

function hold(dir: string, id: string): void {
  const gitDir = fs.readFileSync(path.join(dir, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
  fs.writeFileSync(path.join(gitDir, 'lobstah.lock'), JSON.stringify({ id, lane: 'work', pid: process.pid, at: new Date().toISOString() }));
}

/** A finished dispatch that ran in `dir`, finished `days` ago. */
function finishedIn(id: string, dir: string, days: number): void {
  const done = path.join(laneDirs('work').done, id);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'r', brief: 'b', pool: 'p' }));
  fs.writeFileSync(path.join(done, 'worktree.json'), JSON.stringify({ path: dir, pool: 'p/1' }));
  age(done, days);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-pool-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  config();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('cull leaves pool worktrees alone', () => {
  it('neither the retention cull, the free-space cull, nor an apply removes a pool worktree', () => {
    const dir = slot(1);
    age(dir, 60);
    finishedIn('old', dir, 30);
    // A plain lost worktree beside it is still swept, so the cull did run.
    fs.mkdirSync(path.join(home, 'worktrees', 'ghost'), { recursive: true });
    age(path.join(home, 'worktrees', 'ghost'), 30);
    const plan = planCull(0);
    expect(plan.filter((i) => i.target.startsWith(path.join(home, 'pools')))).toEqual([]);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toContain('worktree:ghost');
    expect(planPressureCull().filter((i) => i.target.startsWith(path.join(home, 'pools')))).toEqual([]);
    applyCull(plan);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(home, 'worktrees', 'ghost'))).toBe(false);
  });
});

describe('tend and status show each pool', () => {
  it('size, free, claimed by which dispatch, out of rotation and why', () => {
    enqueue({ id: 'busy-dispatch', repo: 'r', brief: 'b', pool: 'p' });
    fs.renameSync(path.join(laneDirs('work').queue, 'busy-dispatch.json'), path.join(home, 'busy.json'));
    fs.mkdirSync(path.join(laneDirs('work').active, 'busy-dispatch'));
    fs.renameSync(path.join(home, 'busy.json'), path.join(laneDirs('work').active, 'busy-dispatch', 'descriptor.json'));
    hold(slot(1), 'busy-dispatch');
    slot(2);
    writeSlotOut('p', 2, { reason: '2 commit(s) on no remote branch', at: new Date().toISOString(), dispatch: 'olddispatch1' });
    const r = buildTendReport();
    expect(r.pools).toHaveLength(1);
    expect(r.pools![0]).toMatchObject({ name: 'p', repo: 'r', size: 3, free: 0, overflow: 'queue' });
    expect(r.pools![0]!.slots.map((s) => s.state)).toEqual(['claimed', 'out', 'missing']);
    const text = renderTend(r);
    expect(text).toContain('pools[1]');
    expect(text).toContain('1: busy-dis');
    expect(text).toContain('2: 2 commit(s) on no remote branch (after olddispa');
    expect(text).toContain('3: not created yet');
  });

  it('a queue-mode pool wait is not a stall', () => {
    enqueue({ id: 'waiting', repo: 'r', brief: 'b', pool: 'p' });
    const q = path.join(laneDirs('work').queue, 'waiting.json');
    age(q, 1);
    fs.writeFileSync(path.join(home, 'executor.json'), JSON.stringify({ heartbeat: new Date().toISOString() }));
    const r = buildTendReport();
    expect(r.verdict).not.toBe('stalled');
    expect(r.queueWait).toMatch(/no free worktree in pool p/);
  });
});

describe('the daemon warms pools', () => {
  it('starts a warm-up when a slot is missing, at most once per interval, and none when nothing is due', () => {
    const started: string[] = [];
    const hooks = { spawnPoolWarm: (name: string) => started.push(name), now: () => Date.now() };
    expect(poolPass({ pools: { p: { repo: 'r', size: 1, overflow: 'queue' } } } as never, hooks, () => {})).toEqual(['p']);
    expect(poolPass({ pools: { p: { repo: 'r', size: 1, overflow: 'queue' } } } as never, hooks, () => {})).toEqual([]);
    expect(started).toEqual(['p']);
  });

  it('a pool that is ready and freshly fetched needs nothing', () => {
    slot(1);
    fs.writeFileSync(path.join(home, 'pools', 'p', '.warm-state.json'), JSON.stringify({ fetchedAt: new Date().toISOString() }));
    const started: string[] = [];
    const later = Date.now() + 60_000; // past the spawn throttle of any earlier test
    expect(poolPass({ pools: { p: { repo: 'r', size: 1, overflow: 'queue' } } } as never, { spawnPoolWarm: (n) => started.push(n), now: () => later }, () => {})).toEqual([]);
  });
});

describe('traps never take pool work', () => {
  it('a soaking trap skips a pool dispatch for its repo, and the daemon does not defer it to the trap', () => {
    const worktree = path.join(home, 'wt', 's1');
    fs.mkdirSync(worktree, { recursive: true });
    const res = signOnTrap({ sessionId: 's1', harness: 'claude', repo: 'r', worktree, cwd: worktree, ttlMs: 1800_000 });
    if ('held' in res) throw new Error('unexpected hold');
    enqueue({ id: 'pooled', repo: 'r', brief: 'b', pool: 'p' });
    expect(daemonSkip([res.ok], 90_000)(queuedDescriptor('pooled', 'work')!)).toBe(false);
    expect(claimBait(res.ok)).toBeNull();
    enqueue({ id: 'plain', repo: 'r', brief: 'b' });
    expect(claimBait(res.ok)?.id).toBe('plain');
  });
});

describe('lobstah dispatch --pool', () => {
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const lobstah = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
  };

  it('queues pool work with the pool\'s repo, and refuses an unknown pool, a repo mismatch, or --for', () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const ok = lobstah('dispatch', '--pool', 'p', '--id', id, '--brief-text', 'work');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('pool: p');
    expect(queuedDescriptor(id, 'work')).toMatchObject({ repo: 'r', pool: 'p' });
    const unknown = lobstah('dispatch', '--pool', 'nope', '--brief-text', 'work');
    expect(unknown.status).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toMatch(/unknown pool "nope" — configured pools: p/);
    fs.appendFileSync(path.join(home, 'config.toml'), `\n[repos.other]\npath = ${JSON.stringify(path.join(home, 'other'))}\n`);
    const out = (r: ReturnType<typeof lobstah>) => `${r.stdout}${r.stderr}`;
    expect(out(lobstah('dispatch', '--pool', 'p', '--repo', 'other', '--brief-text', 'work'))).toMatch(/pool p serves repo r, not other/);
    expect(out(lobstah('dispatch', '--pool', 'p', '--for', 'wt:x', '--brief-text', 'work'))).toMatch(/cannot be addressed to a trap/);
  });
});
