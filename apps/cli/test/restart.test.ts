import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout, executorPath } from '@lobstah/core';
import { restartCommand } from '../src/service.js';
import { activeDispatchCounts, restartRefusal } from '../src/restart.js';
import { usageFor } from '../src/usage.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`).
// No test here reaches a real service manager: every CLI run below stops at
// a refusal before launchctl or systemctl would run.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
let userHome: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-restart-'));
  userHome = path.join(home, 'user');
  fs.mkdirSync(userHome);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home, HOME: userHome, USERPROFILE: userHome };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}

/** A unit file where this platform's service manager keeps it, so the service reads as installed. */
function fakeInstall(kind: string): void {
  const file =
    process.platform === 'darwin'
      ? path.join(userHome, 'Library', 'LaunchAgents', `lobstah.${kind}.plist`)
      : path.join(userHome, '.config', 'systemd', 'user', `lobstah-${kind}.service`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

describe('service restart commands', () => {
  it('launchd: kickstart -k the agent label in the user domain', () => {
    expect(restartCommand('daemon', 'darwin', 501)).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/lobstah.daemon']);
    expect(restartCommand('glass', 'darwin', 501)).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/lobstah.glass']);
  });

  it('systemd: restart the user unit', () => {
    expect(restartCommand('daemon', 'linux')).toEqual(['systemctl', '--user', 'restart', 'lobstah-daemon.service']);
    expect(restartCommand('pick', 'linux')).toEqual(['systemctl', '--user', 'restart', 'lobstah-pick.service']);
  });
});

describe('restart refusals', () => {
  it('not installed: names the install command', () => {
    expect(restartRefusal({ kind: 'daemon', installed: false, active: 0, force: false })).toContain('`lobstah daemon install`');
    expect(restartRefusal({ kind: 'pick', installed: false, active: 0, force: false })).toContain('`lobstah pick install`');
  });

  it('the daemon refuses while dispatches are active, and says how many; --force overrides', () => {
    expect(restartRefusal({ kind: 'daemon', installed: true, active: 2, traps: 3, force: false })).toContain('2 headless dispatch(es) and 3 trap catch(es) active');
    expect(restartRefusal({ kind: 'daemon', installed: true, active: 2, force: true })).toBeUndefined();
    expect(restartRefusal({ kind: 'daemon', installed: true, active: 0, traps: 3, force: false })).toBeUndefined();
    expect(restartRefusal({ kind: 'pick', installed: true, active: 2, force: false })).toBeUndefined();
  });
});

describe('lobstah daemon|pick|glass restart', () => {
  it('not installed: exits non-zero with the install command', () => {
    for (const kind of ['daemon', 'pick']) {
      const res = lobstah(kind, 'restart');
      expect(res.status, kind).toBe(1);
      expect(res.stdout).toContain(`the ${kind} service is not installed`);
      expect(res.stdout).toContain(`lobstah ${kind} install`);
    }
  });

  it('glass with neither a service nor a detached glass: exits non-zero and names both ways to start one', () => {
    const res = lobstah('glass', 'restart');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('lobstah glass install');
    expect(res.stdout).toContain('lobstah glass --detach');
  });

  it('the daemon refuses while a dispatch is active; queued work does not block it', () => {
    fakeInstall('daemon');
    enqueue({ id: '11111111-1111-4111-8111-111111111111', repo: 'r', brief: 'b' });
    enqueue({ id: '22222222-2222-4222-8222-222222222222', repo: 'r', brief: 'b' });
    claimNext('work');
    const res = lobstah('daemon', 'restart');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('1 headless dispatch(es)');
    expect(res.stdout).toContain('--force');
  });

  it('a finished dispatch whose runner is still exiting is not active: restart needs no --force', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    enqueue({ id, repo: 'r', brief: 'b' });
    claimNext('work');
    fs.writeFileSync(
      path.join(home, 'active', id, 'runner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), attempts: 1 }),
    );
    appendStatus(id, 'work', 'working');
    expect(activeDispatchCounts()).toEqual({ headless: 1, traps: 0 });
    appendStatus(id, 'work', 'done', 'finished');
    const counts = activeDispatchCounts();
    expect(counts).toEqual({ headless: 0, traps: 0 });
    expect(restartRefusal({ kind: 'daemon', installed: true, active: counts.headless, traps: counts.traps, force: false })).toBeUndefined();
    expect(lobstah('daemon', 'status').stdout).toContain('headless: 0');
  });

  it('counts trap catches separately from supervised runners', () => {
    enqueue({ id: 'trap-catch', repo: 'r', brief: 'b' });
    claimNext('work');
    fs.writeFileSync(path.join(home, 'active', 'trap-catch', 'claim.json'), JSON.stringify({ by: 'wt:trap1' }));
    expect(activeDispatchCounts()).toEqual({ headless: 0, traps: 1 });
  });

  it('usage lists restart, status, and --force', () => {
    expect(usageFor('daemon')).toContain('restart');
    expect(usageFor('daemon')).toContain('status');
    expect(usageFor('daemon')).toContain('--force');
    expect(usageFor('pick')).toContain('restart');
    expect(usageFor('glass')).toContain('restart');
    expect(lobstah('daemon', 'bounce').status).toBe(2);
  });
});

describe('lobstah daemon status', () => {
  it('no heartbeat: stopped, not installed, with the install command', () => {
    const res = lobstah('daemon', 'status');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('daemon: stopped');
    expect(res.stdout).toContain('installed: false');
    expect(res.stdout).toContain('heartbeat: never');
    expect(res.stdout).toContain('lobstah daemon install');
  });

  it('a fresh heartbeat from a live pid: running, with pid, version, and age', () => {
    fakeInstall('daemon');
    fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString(), version: '9.9.9', pid: process.pid }));
    const res = lobstah('daemon', 'status');
    expect(res.stdout).toContain('daemon: running');
    expect(res.stdout).toContain('installed: true');
    expect(res.stdout).toContain(`pid: ${process.pid}`);
    expect(res.stdout).toContain('version: 9.9.9');
    expect(res.stdout).toMatch(/heartbeat: \d+s ago/);
  });
});
