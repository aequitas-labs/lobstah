import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { listProcesses, reapStarted, startedBy } from '../src/reap.js';

describe('startedBy — the processes a root started', () => {
  it('lists every descendant, never the root or unrelated processes', () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 10, ppid: 1, pgid: 5 },
      { pid: 11, ppid: 10, pgid: 5 },
      { pid: 12, ppid: 11, pgid: 12 },
      { pid: 20, ppid: 1, pgid: 20 },
    ];
    expect(startedBy(10, rows).sort((a, b) => a - b)).toEqual([11, 12]);
  });

  it('adds members of the root’s group whose parent is gone, when the root leads the group', () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 30, ppid: 1, pgid: 10 }, // orphaned background work
      { pid: 40, ppid: 1, pgid: 40 },
    ];
    expect(startedBy(10, rows).sort((a, b) => a - b)).toEqual([11, 30]);
  });

  it('does not take the group of a root that does not lead it', () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 9, ppid: 1, pgid: 9 },
      { pid: 10, ppid: 9, pgid: 9 },
      { pid: 11, ppid: 10, pgid: 9 },
      { pid: 30, ppid: 1, pgid: 9 },
    ];
    expect(startedBy(10, rows)).toEqual([11]);
  });

  it('works without process groups (Windows rows)', () => {
    const rows = [
      { pid: 4, ppid: 0 },
      { pid: 10, ppid: 4 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
    ];
    expect(startedBy(10, rows).sort((a, b) => a - b)).toEqual([11, 12]);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

const spawned: number[] = [];
const roots: ChildProcess[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const r of roots.splice(0)) r.kill('SIGKILL');
});

const IDLE = 'setInterval(() => {}, 1000)';

/**
 * A root (the runner's stand-in) that starts a child, which starts a
 * grandchild. With `orphan`, the child exits after starting the grandchild,
 * so the grandchild's parent is gone. Resolves the three pids.
 */
async function tree(orphan: boolean): Promise<{ root: number; child: number; grandchild: number }> {
  const child =
    `const { spawn } = require('child_process');` +
    `const g = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' });` +
    `console.log(g.pid);` +
    (orphan ? `setTimeout(() => process.exit(0), 200);` : IDLE);
  const root =
    `const { spawn } = require('child_process');` +
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'pipe', 'ignore'] });` +
    `c.stdout.once('data', (d) => console.log(JSON.stringify({ child: c.pid, grandchild: Number(String(d).trim()) })));` +
    IDLE;
  // Detached: on POSIX the root leads its own process group, as the daemon
  // spawns the runner.
  const r = spawn(process.execPath, ['-e', root], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
  roots.push(r);
  const line = await new Promise<string>((resolve) => r.stdout!.once('data', (d) => resolve(String(d))));
  const { child: c, grandchild: g } = JSON.parse(line) as { child: number; grandchild: number };
  spawned.push(c, g);
  return { root: r.pid!, child: c, grandchild: g };
}

describe('reapStarted — stops what the runner started', () => {
  it('stops the child and the grandchild, and leaves the root alive', async () => {
    const t = await tree(false);
    expect(await until(() => startedBy(t.root, listProcesses()).includes(t.grandchild), 10_000)).toBe(true);

    const n = await reapStarted(t.root, 500);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await until(() => !alive(t.child) && !alive(t.grandchild), 10_000)).toBe(true);
    expect(alive(t.root)).toBe(true);
  }, 40_000);

  it.skipIf(process.platform === 'win32')('stops background work whose parent already exited, through the process group', async () => {
    const t = await tree(true);
    expect(await until(() => !alive(t.child), 10_000)).toBe(true);
    expect(alive(t.grandchild)).toBe(true);
    expect(startedBy(t.root, listProcesses())).toContain(t.grandchild);

    await reapStarted(t.root, 500);
    expect(await until(() => !alive(t.grandchild), 10_000)).toBe(true);
    expect(alive(t.root)).toBe(true);
  }, 40_000);

  it('leaves processes it did not start alone', async () => {
    const other = spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore', windowsHide: true });
    roots.push(other);
    const t = await tree(false);
    await reapStarted(t.root, 500);
    expect(await until(() => !alive(t.grandchild), 10_000)).toBe(true);
    expect(alive(other.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 40_000);
});
