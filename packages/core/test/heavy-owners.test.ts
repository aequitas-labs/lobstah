import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHeavyLine, ensureLayout, heavyDir, heavyView, joinHeavyLine, laneDirs, liveHeavyTickets, requestCancel, signOnTrap, stowTrap, sweepGhostTraps,
  appendStatus,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const prior = process.env.LOBSTAH_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-owners-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[heavy]\nslots = 1\n');
});
afterEach(() => {
  if (prior === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = prior;
  removeTempDir(home);
});

const seqFile = (seq: number) => path.join(heavyDir(), 'line', `${String(seq).padStart(10, '0')}.json`);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function trap(): string {
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const res = signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: 'claude', sessionId: 's1', ttlMs: 1000 });
  if (!('ok' in res)) throw new Error('sign-on refused');
  return res.ok.trapId;
}

describe('a ticket\'s owner', () => {
  it('stowing a trap takes its waiters out of the line and frees its slot', () => {
    const id = trap();
    const running = joinHeavyLine({ pid: process.pid, command: 'a', trap: id });
    const waiting = joinHeavyLine({ pid: process.pid, command: 'b', trap: id });
    const other = joinHeavyLine({ pid: process.pid, command: 'c', trap: 'someone-else' });
    expect(checkHeavyLine(running.seq).kind).toBe('run');
    stowTrap(id);
    expect(checkHeavyLine(waiting.seq)).toEqual({ kind: 'cancelled', reason: 'its trap was stowed' });
    expect(checkHeavyLine(other.seq).kind).toBe('run');
    expect(heavyView().over.map((t) => t.seq)).toEqual([running.seq]);
  });

  it('cancelling a dispatch takes its waiter out of the line', () => {
    const active = path.join(laneDirs('work').active, 'd1');
    fs.mkdirSync(active, { recursive: true });
    const holder = joinHeavyLine({ pid: process.pid, command: 'a' });
    const waiting = joinHeavyLine({ pid: process.pid, command: 'b', dispatch: 'd1', lane: 'work' });
    expect(checkHeavyLine(holder.seq).kind).toBe('run');
    requestCancel('d1', 'work');
    expect(checkHeavyLine(waiting.seq)).toEqual({ kind: 'cancelled', reason: 'its dispatch was cancelled' });
  });

  it('the ghost sweep leaves a trap with a live ticket, whatever its heartbeat says', () => {
    const id = trap();
    const later = Date.now() + 3600_000;
    const ticket = joinHeavyLine({ pid: process.pid, command: 'a', trap: id });
    // Signed on and parked once, then silent for an hour.
    const file = path.join(home, 'soaking', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), firstParkedAt: new Date().toISOString() }));
    expect(sweepGhostTraps(1000, later)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);

    // Its process died: nothing protects the trap now.
    fs.writeFileSync(seqFile(ticket.seq), JSON.stringify({ ...JSON.parse(fs.readFileSync(seqFile(ticket.seq), 'utf8')), pid: deadPid(), startedAt: undefined }));
    expect(liveHeavyTickets({ trap: id }, later)).toEqual([]);
    expect(sweepGhostTraps(1000, later).map((a) => a.trapId)).toEqual([id]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('paused on the heavy line is a valid report', () => {
    fs.mkdirSync(path.join(laneDirs('work').active, 'd2'), { recursive: true });
    expect(() => appendStatus('d2', 'work', 'paused', 'Push in line', undefined, { waitingOn: 'heavy' })).not.toThrow();
  });
});
