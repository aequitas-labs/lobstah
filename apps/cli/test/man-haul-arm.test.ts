import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout, signOnTrap, takeHelm } from '@lobstah/core';
import { liveWatcher } from '../src/watchers.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const sessionId = 'armed-helm';
const dispatchId = '99999999-9999-9999-9999-999999999999';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-haul-arm-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  takeHelm({ sessionId, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 10_000,
  input: args.includes('haul') ? JSON.stringify({ session_id: sessionId }) : undefined,
});
const haul = () => run('man', 'haul');
const watcherFile = () => path.join(home, 'watchers', `${sessionId}.json`);
const registration = (heartbeatAt: string) => fs.writeFileSync(watcherFile(), JSON.stringify({
  sessionId, kind: 'man', pid: process.pid, heartbeatAt,
}));

describe('man haul arm mode', () => {
  it('blocks with an arm instruction when queued work has no watcher', () => {
    enqueue({ id: dispatchId, repo: 'web', brief: 'b' });
    const res = haul();
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ decision: 'block' });
    expect(res.stdout).toContain(`lobstah man wait --session ${sessionId} --timeout 900`);
  });

  it('allows a stop with a live watcher registration', () => {
    enqueue({ id: dispatchId, repo: 'web', brief: 'b' });
    registration(new Date().toISOString());
    expect(haul().stdout).toBe('');
  });

  it('blocks again when the registration heartbeat is stale', () => {
    enqueue({ id: dispatchId, repo: 'web', brief: 'b' });
    registration(new Date(Date.now() - 10_000).toISOString());
    expect(haul().stdout).toContain('Arm the watcher');
  });

  it('allows a stop with nothing in flight', () => {
    expect(haul().stdout).toBe('');
  });

  it('blocks on a standing question even when a watcher is live', () => {
    enqueue({ id: dispatchId, repo: 'web', brief: 'b' });
    claimNext('work');
    appendStatus(dispatchId, 'work', 'needs-decision', 'which color?');
    registration(new Date().toISOString());
    const res = haul();
    expect(res.stdout).toContain('which color?');
    expect(res.stdout).not.toContain('Arm the watcher');
  });

  it('asks a Claude trap to arm soak --wait, then allows its live watcher', () => {
    const worktree = path.join(home, 'trap-worktree');
    fs.mkdirSync(worktree);
    const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'claude', sessionId: 'armed-trap', ttlMs: 60_000 });
    expect('ok' in signed).toBe(true);
    if (!('ok' in signed)) return;
    enqueue({ id: dispatchId, repo: 'other', brief: 'not for this trap' });
    const trapHaul = () => spawnSync(process.execPath, [cli, 'man', 'haul'], {
      encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home },
      input: JSON.stringify({ session_id: 'armed-trap' }), timeout: 10_000,
    });
    expect(trapHaul().stdout).toContain('lobstah soak --wait --timeout 900');
    fs.writeFileSync(path.join(home, 'watchers', 'armed-trap.json'), JSON.stringify({
      sessionId: 'armed-trap', kind: 'trap', trapId: signed.ok.trapId, pid: process.pid, heartbeatAt: new Date().toISOString(),
    }));
    expect(trapHaul().stdout).toBe('');
  });
});

describe('man wait watcher lifecycle', () => {
  it('registers and heartbeats while running, refuses a second waiter, then removes its file', async () => {
    const child = spawn(process.execPath, [cli, 'man', 'wait', '--session', sessionId, '--timeout', '3'], {
      env: { ...process.env, LOBSTAH_HOME: home }, stdio: 'pipe',
    });
    try {
      const deadline = Date.now() + 4_000;
      while (!liveWatcher(sessionId, 'man') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(liveWatcher(sessionId, 'man')?.pid).toBe(child.pid);
      const second = run('man', 'wait', '--session', sessionId, '--timeout', '1');
      expect(second.status).toBe(1);
      expect(second.stdout).toContain(`pid ${child.pid}`);
      const firstBeat = liveWatcher(sessionId, 'man')!.heartbeatAt;
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      expect(liveWatcher(sessionId, 'man')!.heartbeatAt).not.toBe(firstBeat);
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(fs.existsSync(watcherFile())).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 10_000);
});
