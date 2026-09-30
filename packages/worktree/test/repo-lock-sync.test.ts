import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { withRepoLockSync } from '../src/index.js';

// The synchronous form of the per-repo git lock (#127), for the release pass.
let root: string;
let repo: string;
let lock: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-lock-sync-'));
  repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  lock = path.join(repo, '.git', 'lobstah-git.lock');
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

/** Another process holds the lock and lets go after `ms`. */
function heldElsewhere(ms: number): ChildProcess {
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,at:new Date().toISOString()}));setTimeout(()=>{fs.rmSync(${JSON.stringify(lock)},{force:true});process.exit(0)},${ms});`;
  const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  children.push(c);
  return c;
}

const waitFor = (check: () => boolean) => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 200 && !check(); i++) Atomics.wait(pause, 0, 0, 25);
};

describe('withRepoLockSync', () => {
  it("waits for another process's lock, runs, and releases its own", () => {
    heldElsewhere(600);
    waitFor(() => fs.existsSync(lock));
    const t0 = Date.now();
    let sawLockAsMine = false;
    const out = withRepoLockSync(repo, () => {
      sawLockAsMine = (JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }).pid === process.pid;
      return 'fetched';
    });
    expect(out).toBe('fetched');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(sawLockAsMine).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('clears a lock whose process is gone, and does not wait on its own process', () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, at: new Date().toISOString() }));
    expect(withRepoLockSync(repo, () => 1)).toBe(1);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const t0 = Date.now();
    expect(withRepoLockSync(repo, () => 2)).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Not ours to remove: the in-process holder still has it.
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('outside a git checkout it just runs', () => {
    expect(withRepoLockSync(root, () => 'ran')).toBe('ran');
  });
});
