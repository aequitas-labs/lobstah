import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, ensureLayout, GB, lastCullPassAt, loadConfig, tryDirLock } from '@lobstah/core';
import { retentionPass, spaceGuard } from '@lobstah/supervisor';
import { runCullWorker } from '../src/background-cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-background-cull-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nretentionDays = 1\n');
});
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });

describe('background culling', () => {
  it('the worker entry drains more than ten checkouts and their metadata in one pass', () => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    fs.appendFileSync(path.join(home, 'config.toml'), `\n[repos.r]\npath = ${JSON.stringify(repo)}\n`);
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (let i = 0; i < 15; i++) {
      const id = `backlog-${i}`;
      git('worktree', 'add', '-q', '-b', id, path.join(home, 'worktrees', id));
      const done = path.join(home, 'done', id);
      fs.mkdirSync(done);
      fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'r', brief: 'finished' }));
      fs.utimesSync(done, old, old);
    }
    const result = spawnSync(process.execPath, [cli, '__cull'], { env: { ...process.env, LOBSTAH_HOME: home }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(path.join(home, 'worktrees'))).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'done'))).toEqual([]);
    expect(result.stdout).toContain('15 finished dispatch(es)');
    expect(lastCullPassAt()).toBeDefined();
  });

  it('the claim loop schedules cleanup without running removals inline', () => {
    const cfg = loadConfig();
    cfg.limits = { ...DEFAULT_LIMITS, retentionDays: 1, minFreeGB: 10 };
    let scheduled = 0;
    const culler = {
      start: () => { scheduled++; return true; },
      retention: () => { throw new Error('must run outside the claim loop'); },
      pressure: () => { throw new Error('must run outside the claim loop'); },
    };
    expect(retentionPass(cfg, { culler }, () => {})).toBe(true);
    expect(spaceGuard(cfg, { culler, freeBytes: () => 3 * GB }, () => {})).toBe(false);
    expect(scheduled).toBe(2);
    expect(lastCullPassAt()).toBeUndefined(); // only the worker stamps an actual pass
  });

  it('schedules cache-pressure work even when the dispatch free-space floor is off', () => {
    const cfg = loadConfig();
    cfg.limits = { ...DEFAULT_LIMITS, minFreeGB: 0, cacheMinFreeGB: 20 };
    let scheduled = 0;
    const culler = { start: () => { scheduled++; return true; }, retention: () => 0, pressure: () => 0 };
    expect(spaceGuard(cfg, { culler, freeBytes: () => GB }, () => {})).toBe(true);
    expect(scheduled).toBe(1);
  });

  it('does not overlap a live worker, including after a daemon restart', async () => {
    const lock = tryDirLock(path.join(home, 'cull-worker.lock'), { staleMs: 1000 });
    expect(lock).toBeDefined();
    try {
      expect(await runCullWorker()).toBe(false);
      expect(lastCullPassAt()).toBeUndefined();
    } finally { lock!.release(); }
    expect(await runCullWorker()).toBe(true);
  });
});
