import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, DEFAULT_LIMITS, enqueue, holdWatch, writeHold, ensureLayout, executorPath, GB, laneDirs, listNotices, loadConfig, readHold } from '@lobstah/core';
import type { Config } from '@lobstah/core';
import { CULL_INTERVAL_MS, retentionPass, spaceGuard, tick } from '@lobstah/supervisor';
import type { DaemonCuller } from '@lobstah/supervisor';
import { buildTendReport, renderTend } from '../src/tend.js';
import { diskRow } from '../src/doctor.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-disk-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function limits(extra: Partial<Config['limits']>): void {
  const body = Object.entries(extra).map(([k, v]) => `${k} = ${v}`).join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), `[limits]\n${body}\n`);
}

function fakeCuller(): DaemonCuller & { retentionCalls: number; pressureCalls: number } {
  const c = {
    retentionCalls: 0,
    pressureCalls: 0,
    retention: () => {
      c.retentionCalls++;
      return 0;
    },
    pressure: () => {
      c.pressureCalls++;
      return 0;
    },
  };
  return c;
}

const disk = (n: number) => n * GB;
const kinds = () => listNotices(50).map((n) => n.kind).filter((k) => k.startsWith('disk-'));

describe('minFreeGB — the free-space guard', () => {
  it('holds queued work in the queue with a reason tend shows, then clears when space returns', () => {
    limits({ minFreeGB: 10 });
    enqueue({ id: 'held-1', repo: 'r', brief: 'b' });
    let free = disk(3.2);
    const culler = fakeCuller();
    const hooks = { culler, freeBytes: () => free };

    tick(() => {}, hooks);
    tick(() => {}, hooks);
    tick(() => {}, hooks);

    // Still queued, not claimed and not failed.
    expect(fs.existsSync(path.join(laneDirs('work').queue, 'held-1.json'))).toBe(true);
    expect(fs.readdirSync(laneDirs('work').active)).toEqual([]);
    expect(culler.pressureCalls).toBe(3); // the guard tries a cull first, every cycle
    expect(readHold()).toMatchObject({ freeBytes: disk(3.2), needBytes: disk(10) });

    // tend shows the held dispatch with the reason, and a hold is not "stalled".
    fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(laneDirs('work').queue, 'held-1.json'), old, old);
    const report = buildTendReport();
    expect(report.verdict).toBe('working');
    const d = report.stories.flatMap((s) => s.dispatches).find((x) => x.id === 'held-1');
    expect(d).toMatchObject({ state: 'held', note: 'held: 3.2 GB free, needs 10 GB' });
    const text = renderTend(report);
    expect(text).toContain('held-1:held (3.2 GB free, needs 10 GB)');
    expect(text).toContain('held: 3.2 GB free, needs 10 GB');

    // One notice for the hold, not one per cycle.
    expect(kinds()).toEqual(['disk-held']);

    // Space returns: the guard clears the hold and posts one clear notice.
    free = disk(50);
    const log: string[] = [];
    expect(spaceGuard(loadConfig(), hooks, (m) => log.push(m))).toBe(true);
    expect(readHold()).toBeUndefined();
    expect(kinds()).toEqual(['disk-held', 'disk-cleared']);
    expect(spaceGuard(loadConfig(), hooks, () => {})).toBe(true);
    expect(kinds()).toEqual(['disk-held', 'disk-cleared']);
    expect(buildTendReport().stories.flatMap((s) => s.dispatches).find((x) => x.id === 'held-1')?.state).toBe('queued');
  });

  it('tend shows a disk hold and a fork-cap watch hold side by side', () => {
    fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
    enqueue({ id: 'both-1', repo: 'r', brief: 'b' });
    writeHold({ since: new Date().toISOString(), checkedAt: new Date().toISOString(), freeBytes: disk(2), needBytes: disk(10), dir: '/wt' });
    addWatch('pr:acme/web#2', 'true', { owner: 'dispatch:88888888-8888-8888-8888-888888888888' });
    holdWatch('pr:acme/web#2');
    const r = buildTendReport();
    expect(r.hold?.reason).toBe('held: 2 GB free, needs 10 GB');
    expect(r.watches.find((w) => w.key === 'pr:acme/web#2')?.heldAt).toBeDefined();
    const text = renderTend(r);
    expect(text).toContain('diskHold: "held: 2 GB free, needs 10 GB on /wt (since');
    expect(text).toContain('both-1:held (2 GB free, needs 10 GB)');
    expect(text).toMatch(/pr:acme\/web#2[^\n]*held/);
  });

  it('runs the cull first and claims without a hold when the cull frees enough', () => {
    const cfg: Config = { ...loadConfig(), limits: { ...DEFAULT_LIMITS, minFreeGB: 10 } };
    let free = disk(4);
    const culler: DaemonCuller = {
      retention: () => 0,
      pressure: (enough) => {
        free = disk(12);
        return enough() ? 1 : 0;
      },
    };
    expect(spaceGuard(cfg, { culler, freeBytes: () => free }, () => {})).toBe(true);
    expect(readHold()).toBeUndefined();
    expect(kinds()).toEqual([]);
  });

  it('holds even with retentionDays at 0, and never reads the disk when minFreeGB is off', () => {
    const on: Config = { ...loadConfig(), limits: { ...DEFAULT_LIMITS, minFreeGB: 10, retentionDays: 0 } };
    expect(spaceGuard(on, { freeBytes: () => disk(1) }, () => {})).toBe(false);
    const off: Config = { ...loadConfig(), limits: { ...DEFAULT_LIMITS } };
    let reads = 0;
    expect(spaceGuard(off, { freeBytes: () => (reads++, 0) }, () => {})).toBe(true);
    expect(reads).toBe(0);
    expect(readHold()).toBeUndefined(); // turning the guard off lifts the hold
  });

  it('a failed free-space read never blocks claiming', () => {
    const cfg: Config = { ...loadConfig(), limits: { ...DEFAULT_LIMITS, minFreeGB: 10 } };
    const read = () => {
      throw new Error('statfs unsupported');
    };
    expect(spaceGuard(cfg, { freeBytes: read }, () => {})).toBe(true);
  });

  it('doctor reports free space, the limits, and the cullable worktrees', () => {
    limits({ minFreeGB: 10, retentionDays: 14 });
    fs.mkdirSync(path.join(home, 'worktrees', 'orphan'));
    const row = diskRow(loadConfig(), () => disk(3.2));
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/^3\.2 GB free on .*worktrees; minFreeGB 10; retentionDays 14; 1 cullable worktree\(s\), oldest 0d$/);
    expect(diskRow({ ...loadConfig(), limits: { ...DEFAULT_LIMITS } }, () => disk(80)).status).toBe('ok');
  });
});

describe('retentionDays — the throttle', () => {
  it('runs at most once per hour, and never when retentionDays is 0', () => {
    const culler = fakeCuller();
    const base = Date.parse('2026-09-01T00:00:00Z');
    let now = base;
    const cfg: Config = { ...loadConfig(), limits: { ...DEFAULT_LIMITS, retentionDays: 14 } };
    const hooks = { culler, now: () => now };

    expect(retentionPass(cfg, hooks, () => {})).toBe(true);
    now = base + CULL_INTERVAL_MS - 1;
    expect(retentionPass(cfg, hooks, () => {})).toBe(false);
    now = base + CULL_INTERVAL_MS;
    expect(retentionPass(cfg, hooks, () => {})).toBe(true);
    expect(culler.retentionCalls).toBe(2);

    const off: Config = { ...cfg, limits: { ...DEFAULT_LIMITS, retentionDays: 0 } };
    now += 10 * CULL_INTERVAL_MS;
    expect(retentionPass(off, hooks, () => {})).toBe(false);
    expect(culler.retentionCalls).toBe(2);
  });

  it('the default config changes nothing: both limits are off', () => {
    expect(DEFAULT_LIMITS.retentionDays).toBe(0);
    expect(DEFAULT_LIMITS.minFreeGB).toBe(0);
  });
});
