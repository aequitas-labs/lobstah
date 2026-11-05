import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHeavyLine, DEFAULT_HEAVY, dropHeavyTickets, formatHeavyView, HEAVY_WAITER_GRACE_MS, heavyDir, heavySlots, heavyView, heavyWorkerEnv,
  heavyWorkers, joinHeavyLine, loadConfig, ordinal, releaseHeavyTicket, setHeavyGroup, tickHeavyTicket,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const prior = process.env.LOBSTAH_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  if (prior === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = prior;
  removeTempDir(home);
});

const setConfig = (toml: string) => fs.writeFileSync(path.join(home, 'config.toml'), toml);
const ticketPath = (seq: number) => path.join(heavyDir(), 'line', `${String(seq).padStart(10, '0')}.json`);
const editTicket = (seq: number, change: Record<string, unknown>) =>
  fs.writeFileSync(ticketPath(seq), JSON.stringify({ ...JSON.parse(fs.readFileSync(ticketPath(seq), 'utf8')), ...change }));
const join = (extra: Partial<Parameters<typeof joinHeavyLine>[0]> = {}) =>
  joinHeavyLine({ pid: process.pid, command: 'git push', repo: 'r', ...extra });

/** A pid that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

describe('heavy limits', () => {
  it('auto gives 1 slot below 14 cores and 2 from there, and a third of the cores as workers', () => {
    expect(heavySlots(DEFAULT_HEAVY, 13)).toBe(1);
    expect(heavySlots(DEFAULT_HEAVY, 14)).toBe(2);
    expect(heavySlots({ ...DEFAULT_HEAVY, slots: 3 }, 4)).toBe(3);
    expect(heavyWorkers(DEFAULT_HEAVY, 14)).toBe(4);
    expect(heavyWorkers(DEFAULT_HEAVY, 4)).toBe(2);
    expect(heavyWorkers({ ...DEFAULT_HEAVY, workers: 6 }, 4)).toBe(6);
  });

  it('sets the worker limit under every name vitest reads, keeping one already set', () => {
    expect(heavyWorkerEnv(4, {})).toEqual({ VITEST_MAX_WORKERS: '4', VITEST_MAX_FORKS: '4', VITEST_MAX_THREADS: '4' });
    expect(heavyWorkerEnv(4, { VITEST_MAX_FORKS: '1' }).VITEST_MAX_FORKS).toBe('1');
  });

  it('reads [heavy] from the config and refuses nonsense', () => {
    setConfig('[heavy]\nslots = 3\nholdLimitMins = 10\n');
    expect(loadConfig().heavy).toMatchObject({ slots: 3, workers: 'auto', holdLimitMins: 10 });
    setConfig('[heavy]\nslots = 0\n');
    expect(() => loadConfig()).toThrow(/slots/);
    setConfig('[heavy]\nholdLimitMins = "soon"\n');
    expect(() => loadConfig()).toThrow(/holdLimitMins/);
  });
});

describe('the line', () => {
  it('starts first in, first out, up to the limit', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    expect(checkHeavyLine(b.seq)).toMatchObject({ kind: 'wait', position: 2 });
    expect(checkHeavyLine(a.seq)).toEqual({ kind: 'run', slot: 1, slots: 1 });
    expect(checkHeavyLine(b.seq)).toMatchObject({ kind: 'wait', position: 1, running: [expect.objectContaining({ seq: a.seq })] });
    releaseHeavyTicket(a.seq);
    expect(checkHeavyLine(b.seq)).toMatchObject({ kind: 'run' });
  });

  it('reads the limit on every check, and holders already running carry on', () => {
    setConfig('[heavy]\nslots = 2\n');
    const a = join();
    const b = join();
    const c = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    expect(checkHeavyLine(b.seq).kind).toBe('run');
    expect(checkHeavyLine(c.seq).kind).toBe('wait');
    setConfig('[heavy]\nslots = 3\n');
    expect(checkHeavyLine(c.seq).kind).toBe('run');
    setConfig('[heavy]\nslots = 1\n');
    expect(heavyView().running).toHaveLength(3);
  });

  it('keeps the last good limit while the config is mid-edit', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    setConfig('[heavy\nslots = ');
    expect(checkHeavyLine(b.seq).kind).toBe('wait');
  });

  it('clears a holder whose process died, once its group is gone too', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    editTicket(a.seq, { pid: deadPid(), startedAt: undefined });
    expect(checkHeavyLine(b.seq).kind).toBe('run');
    expect(fs.existsSync(ticketPath(a.seq))).toBe(false);
  });

  it('clears a ticket whose pid now belongs to a later process', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    editTicket(a.seq, { startedAt: 'Mon Jan  1 00:00:00 2001' });
    // The start time is cached per pid, so this needs a pid not yet read.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      editTicket(a.seq, { pid: other.pid });
      expect(checkHeavyLine(b.seq).kind).toBe('run');
      expect(fs.existsSync(ticketPath(a.seq))).toBe(false);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the slot while a dead wrapper\'s command still runs', async () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    const cmd = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true });
    try {
      setHeavyGroup(a.seq, cmd.pid!);
      editTicket(a.seq, { pid: deadPid(), startedAt: undefined });
      expect(checkHeavyLine(b.seq).kind).toBe('wait');
      await new Promise<void>((resolve) => {
        cmd.once('close', () => resolve());
        process.kill(-cmd.pid!, 'SIGKILL');
      });
      expect(checkHeavyLine(b.seq).kind).toBe('run');
    } finally {
      try {
        process.kill(-cmd.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('skips a dead waiter, keeps its place for a retry from the same session, then forgets it', () => {
    setConfig('[heavy]\nslots = 1\n');
    const now = Date.now();
    const a = join({ session: 's1' });
    const b = join({ session: 's2' });
    editTicket(a.seq, { pid: deadPid(), startedAt: undefined });
    expect(checkHeavyLine(b.seq, now)).toMatchObject({ kind: 'run' });
    releaseHeavyTicket(b.seq);

    const retry = join({ session: 's1' });
    expect(retry.seq).toBe(a.seq);

    editTicket(a.seq, { pid: deadPid(), startedAt: undefined, deadAt: now - HEAVY_WAITER_GRACE_MS });
    const c = join({ session: 's1' });
    expect(c.seq).toBeGreaterThan(a.seq);
    expect(fs.existsSync(ticketPath(a.seq))).toBe(false);
  });

  it('a retry with no killed waiter goes to the back', () => {
    const a = join({ session: 's1' });
    const b = join({ session: 's1' });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('a waiter alive again is not skipped', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    const b = join();
    editTicket(a.seq, { deadAt: Date.now() });
    expect(checkHeavyLine(b.seq)).toMatchObject({ kind: 'wait', position: 2 });
  });

  it('frees the slot at the time limit and leaves the command running, counting active time only', () => {
    setConfig('[heavy]\nslots = 1\nholdLimitMins = 1\n');
    const now = Date.now();
    const a = join();
    const b = join();
    expect(checkHeavyLine(a.seq, now).kind).toBe('run');
    // A night's sleep is one capped tick, not hours of active time.
    expect(tickHeavyTicket(a.seq, now + 8 * 3600_000)).toBe(false);
    expect(JSON.parse(fs.readFileSync(ticketPath(a.seq), 'utf8')).activeMs).toBe(30_000);
    expect(checkHeavyLine(b.seq, now + 8 * 3600_000).kind).toBe('wait');
    expect(tickHeavyTicket(a.seq, now + 8 * 3600_000 + 30_000)).toBe(true);
    expect(tickHeavyTicket(a.seq, now + 8 * 3600_000 + 40_000)).toBe(false);
    expect(heavyView().over).toEqual([expect.objectContaining({ seq: a.seq })]);
    expect(checkHeavyLine(b.seq, now + 8 * 3600_000 + 40_000).kind).toBe('run');
  });

  it('drops a stopped owner\'s tickets: waiters run nothing, a running command loses its slot', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join({ trap: 't1' });
    const b = join({ trap: 't1', dispatch: 'd1' });
    const c = join({ trap: 't2' });
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    expect(dropHeavyTickets({ trap: 't1' }, 'trap stowed')).toBe(2);
    expect(checkHeavyLine(b.seq)).toEqual({ kind: 'cancelled', reason: 'trap stowed' });
    expect(fs.existsSync(ticketPath(b.seq))).toBe(false);
    expect(checkHeavyLine(c.seq).kind).toBe('run');
    expect(heavyView().over).toEqual([expect.objectContaining({ seq: a.seq })]);
  });

  it('a corrupt ticket blocks no one', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join();
    fs.writeFileSync(path.join(heavyDir(), 'line', '0000000000.json'), '{nope');
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    expect(fs.existsSync(path.join(heavyDir(), 'line', '0000000000.json'))).toBe(false);
  });

  it('reports a ticket that vanished as lost, which is not a cancellation', () => {
    const a = join();
    fs.rmSync(ticketPath(a.seq));
    expect(checkHeavyLine(a.seq)).toEqual({ kind: 'lost' });
  });

  it('keeps each run\'s time for measuring the defaults', () => {
    const a = join();
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    releaseHeavyTicket(a.seq, 3);
    const [line] = fs.readFileSync(path.join(heavyDir(), 'history.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(line!)).toMatchObject({ repo: 'r', command: 'git push', exit: 3 });
  });
});

describe('the view', () => {
  it('shows who runs and who waits, in order', () => {
    setConfig('[heavy]\nslots = 1\n');
    const a = join({ repo: 'homebase', label: 'fresh-cove' });
    join({ repo: 'lobstah', label: 'amber-gull', command: 'vitest run' });
    join({ repo: 'homebase', dispatch: '03e2d892-aaaa' });
    expect(checkHeavyLine(a.seq).kind).toBe('run');
    const text = formatHeavyView({ ...heavyView(), load: 31 });
    expect(text.split('\n')[0]).toBe('heavy: 1 of 1 running · 2 waiting · load 31');
    expect(text).toMatch(/running\s+homebase · fresh-cove\s+git push\s+0m/);
    expect(text).toMatch(/waiting\s+lobstah · amber-gull\s+vitest run\s+0m\s+1st/);
    expect(text).toMatch(/waiting\s+homebase · worker 03e2d892\s+git push\s+0m\s+2nd/);
  });

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });
});
