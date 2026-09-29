import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { claimNext, DEFAULT_LIMITS, DEFAULT_SOAK, enqueue, ensureLayout, laneDirs, readStatusLog, statusPath } from '@lobstah/core';
import { reconcileOne } from '../src/daemon.js';
import type { ActiveState } from '../src/daemon.js';

let home: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-finished-runner-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const cfg = { repos: {}, harness: {}, limits: { ...DEFAULT_LIMITS, exitGraceSecs: 30, wedgeThresholdSecs: 600 }, soak: DEFAULT_SOAK };

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

/** A live stand-in runner in its own process group, as the daemon spawns it. */
function runnerProcess(): number {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
  children.push(c);
  return c.pid!;
}

/** An active dispatch whose worker reported done `agoSecs` ago, with a live runner. */
function finished(id: string, agoSecs: number): ActiveState {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  claimNext('work');
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  fs.writeFileSync(
    statusPath(id, 'work'),
    `${JSON.stringify({ at: at(agoSecs + 60), verb: 'working' })}\n${JSON.stringify({ at: at(agoSecs), verb: 'done', note: 'finished' })}\n`,
  );
  const pid = runnerProcess();
  const runner = { pid, startedAt: at(agoSecs + 120), attempts: 1 };
  const dir = path.join(laneDirs('work').active, id);
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(runner));
  return { id, lane: 'work', dir, runner };
}

describe('the daemon and a runner alive after its dispatch finished', () => {
  it('stops a runner still alive long after done, and does not restart the dispatch', async () => {
    const st = finished('late', 2 * 3600);
    const spawned: string[] = [];
    const logs: string[] = [];
    reconcileOne(st, cfg, (m) => logs.push(m), (s) => { spawned.push(s.id); });

    expect(await until(() => !alive(st.runner!.pid), 10_000)).toBe(true);
    expect(logs.join('\n')).toMatch(/done .* but its runner is alive — stopping group/);
    // The next pass finds it dead: finalized, never respawned, still done.
    reconcileOne(st, cfg, () => {}, (s) => { spawned.push(s.id); });
    expect(spawned).toEqual([]);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'late'))).toBe(true);
    expect(readStatusLog('late', 'work').map((e) => e.verb)).toEqual(['working', 'done']);
  }, 20_000);

  it('leaves a runner that is still inside its exit window', async () => {
    const st = finished('fresh', 5);
    reconcileOne(st, cfg, () => {}, () => {});
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(st.runner!.pid)).toBe(true);
    expect(fs.existsSync(st.dir)).toBe(true);
  });
});
