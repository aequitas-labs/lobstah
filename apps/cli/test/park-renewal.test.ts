import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, executorPath, readTrap, signOnTrap, stowTrap } from '@lobstah/core';
import { MAX_INSTANT_PARKS, parkRenewal, RENEW_REASON } from '../src/park-renewal.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = 'codex-trap-session';
let home: string;
let trapId: string;

const daemonUp = () => fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString(), pid: process.pid }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-renew-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ sessionId: SESSION, harness: 'codex', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  trapId = signed.ok.trapId;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('parkRenewal', () => {
  it('renews while the trap is signed on: the continuation says only to park again', () => {
    expect(parkRenewal(trapId, 60_000)).toEqual({ renew: true, output: { decision: 'block', reason: RENEW_REASON } });
  });

  it('does not renew after the trap stows', () => {
    stowTrap(trapId, 'signed off', SESSION);
    expect(parkRenewal(trapId, 60_000)).toEqual({ renew: false });
  });

  it('renews even when the daemon has never written a heartbeat', () => {
    expect(parkRenewal(trapId, 60_000)).toEqual({ renew: true, output: { decision: 'block', reason: RENEW_REASON } });
  });

  it('backs off: parks that return at once stop renewing after the cap; a real park resets the run', () => {
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(parkRenewal(trapId, 10).renew).toBe(true);
    const stop = parkRenewal(trapId, 10);
    expect(stop.renew).toBe(false);
    expect(stop.output && 'systemMessage' in stop.output ? stop.output.systemMessage : '').toContain(`returned at once ${MAX_INSTANT_PARKS} times in a row`);
    // The run starts over.
    expect(parkRenewal(trapId, 10).renew).toBe(true);
    expect(parkRenewal(trapId, 60_000).renew).toBe(true);
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(parkRenewal(trapId, 10).renew).toBe(true);
  });
});

describe('the Stop hook renews a timed-out park', () => {
  const stop = () =>
    spawnSync(process.execPath, [cli, 'hook', 'stop', '--timeout', '1'], {
      encoding: 'utf8',
      env: { ...process.env, LOBSTAH_HOME: home },
      input: JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop' }),
      timeout: 20_000,
    });

  it('renews while soaked, backs off after instant parks, and stops after stow', { timeout: 60_000 }, () => {
    daemonUp();
    // A one-second park returns "at once": renewals count toward the cap.
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(JSON.parse(stop().stdout)).toEqual({ decision: 'block', reason: RENEW_REASON });
    expect(JSON.parse(stop().stdout).systemMessage).toContain('stopped renewing');
    stowTrap(trapId, 'signed off', SESSION);
    expect(stop().stdout).toBe('');
  });

  it('re-parks without asking a person when the daemon is down', () => {
    expect(JSON.parse(stop().stdout)).toEqual({ decision: 'block', reason: RENEW_REASON });
  });

  it.each(['codex', 'claude'])('%s re-parks after a stale heartbeat, then delivers addressed work when the daemon returns', (harness) => {
    const registration = readTrap(trapId)!;
    signOnTrap({ ...registration, harness, ttlMs: 60_000 });
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\npark="block"\n');
    fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date(Date.now() - 120_000).toISOString(), pid: process.pid }));
    // The harness re-enters Stop only if the timed-out hook asks it to continue.
    const afterSleep = stop();
    expect(afterSleep.status, afterSleep.stderr).toBe(0);
    expect(JSON.parse(afterSleep.stdout)).toEqual({ decision: 'block', reason: RENEW_REASON });
    daemonUp();
    enqueue({ id: `after-sleep-${harness}`, repo: 'web', for: `wt:${trapId}`, brief: 'Handle the queued work after sleep' });
    const recovered = stop();
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ decision: 'block' });
    expect(recovered.stdout).toContain(`assigned dispatch after-sleep-${harness}`);
    expect(recovered.stdout).toContain('Handle the queued work after sleep');
  });
});
