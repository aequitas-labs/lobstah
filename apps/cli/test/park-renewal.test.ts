import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, executorPath, signOnTrap, stowTrap } from '@lobstah/core';
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
    expect(parkRenewal(trapId, 60_000, Date.now(), true)).toEqual({ renew: true, output: { decision: 'block', reason: RENEW_REASON } });
  });

  it('does not renew after the trap stows', () => {
    stowTrap(trapId, 'signed off', SESSION);
    expect(parkRenewal(trapId, 60_000, Date.now(), true)).toEqual({ renew: false });
  });

  it('does not renew when the daemon is unreachable, and says so', () => {
    const r = parkRenewal(trapId, 60_000, Date.now(), false);
    expect(r.renew).toBe(false);
    expect(r.output && 'systemMessage' in r.output ? r.output.systemMessage : '').toContain('the daemon is not answering');
  });

  it('backs off: parks that return at once stop renewing after the cap; a real park resets the run', () => {
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(parkRenewal(trapId, 10, Date.now(), true).renew).toBe(true);
    const stop = parkRenewal(trapId, 10, Date.now(), true);
    expect(stop.renew).toBe(false);
    expect(stop.output && 'systemMessage' in stop.output ? stop.output.systemMessage : '').toContain(`returned at once ${MAX_INSTANT_PARKS} times in a row`);
    // The run starts over.
    expect(parkRenewal(trapId, 10, Date.now(), true).renew).toBe(true);
    expect(parkRenewal(trapId, 60_000, Date.now(), true).renew).toBe(true);
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(parkRenewal(trapId, 10, Date.now(), true).renew).toBe(true);
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

  it('renews while soaked, backs off after instant parks, and stops after stow', () => {
    daemonUp();
    // A one-second park returns "at once": renewals count toward the cap.
    for (let i = 1; i < MAX_INSTANT_PARKS; i++) expect(JSON.parse(stop().stdout)).toEqual({ decision: 'block', reason: RENEW_REASON });
    expect(JSON.parse(stop().stdout).systemMessage).toContain('stopped renewing');
    stowTrap(trapId, 'signed off', SESSION);
    expect(stop().stdout).toBe('');
  });

  it('prints the daemon note instead of renewing when the daemon is down', () => {
    expect(JSON.parse(stop().stdout).systemMessage).toContain('the daemon is not answering');
  });
});
