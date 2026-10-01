import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, ensureLayout, mergeEvidence } from '@lobstah/core';
import { readStats, renderStats } from '../src/stats.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { keeperCount } from '../src/glass-diff.js';
import { pollBody } from '../src/glass-poll.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stats-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.mkdirSync(path.join(home, 'trap-names'));
  for (const [name, trapId] of [['kind-crab', 'a'], ['stowed-crab', 'b'], ['idle-crab', 'c']])
    fs.writeFileSync(path.join(home, 'trap-names', `${name}.json`), JSON.stringify({ trapId }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function fixture(): void {
  // No active/done directories or registrations: retained state alone suffices.
  for (const [id, lane, trap, verb] of [
    ['plan', 'work', 'a', 'done'], ['report', 'chore', 'a', 'done'],
    ['failure', 'work', 'a', 'failed'], ['cancelled', 'work', 'b', 'failed'],
    ['stowed', 'work', 'b', 'done'], ['headless', 'work', undefined, 'done'],
  ] as const) {
    mergeEvidence(id, lane, { ...(trap && { deliveredTo: `wt:${trap}` }), deliveredAt: '2026-09-01T00:00:00Z' });
    appendStatus(id, lane, verb, verb === 'failed' ? 'cancelled before claim' : 'finished', '2026-09-02T00:00:00Z');
  }
}

describe('stats from retained state', () => {
  it('survives stow/restart, includes both lanes and excludes headless/cancelled work', () => {
    fixture();
    expect(readStats()).toMatchObject({ traps: 3, keepers: 3, perTrap: [
      { name: 'kind-crab', keepers: 2 }, { name: 'stowed-crab', keepers: 1 }, { name: 'idle-crab', keepers: 0 },
    ] });
    const result = spawnSync(process.execPath, [cli, 'stats', '--json'], { encoding: 'utf8', env: process.env });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(readStats());
  });

  it('prints TOON totals and a sorted per-trap table through the CLI', () => {
    fixture();
    const result = spawnSync(process.execPath, [cli, 'stats'], { encoding: 'utf8', env: process.env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(renderStats(readStats()));
    expect(result.stdout).toContain('traps: 3\nkeepers: 3\nperTrap[3]{name,keepers,firstSeen,lastKeeperAt}:');
    expect(result.stdout).toContain('kind-crab,2,2026-09-01T00:00:00.000Z,2026-09-02T00:00:00.000Z');
  });

  it('caches quiet reads but invalidates after status/receipt/name changes', () => {
    fixture();
    const first = readStats();
    expect(readStats()).toBe(first);
    appendStatus('failure', 'work', 'done', 'recovered', '2026-09-03T00:00:00Z');
    expect(readStats().keepers).toBe(4);
    mergeEvidence('failure', 'work', { deliveredTo: 'wt:b' });
    expect(readStats().perTrap.find((t) => t.name === 'stowed-crab')?.keepers).toBe(2);
    fs.renameSync(path.join(home, 'trap-names', 'stowed-crab.json'), path.join(home, 'trap-names', 'renamed-crab.json'));
    expect(readStats().perTrap.some((t) => t.name === 'renamed-crab')).toBe(true);
  });

  it('keeps totals slim and includes a new keeper in the poll ETag', () => {
    fixture();
    const full = buildGlassSnapshot();
    expect(full.stats).toEqual({ traps: 3, keepers: 3 });
    expect(full.traps.find((t) => t.name === 'stowed-crab')).toMatchObject({ live: false, keepers: 1 });
    const first = pollBody(full, Date.now());
    expect(JSON.parse(first.body).stats.perTrap).toBeUndefined();
    expect(pollBody({ ...full, now: new Date().toISOString() }, Date.now()).hash).toBe(first.hash);
    appendStatus('failure', 'work', 'done', 'recovered');
    const next = buildGlassSnapshot();
    expect(next.stats?.keepers).toBe(4);
    expect(pollBody(next, Date.now()).hash).not.toBe(first.hash);
  });

  it('retains legacy unnamed trap receipts instead of losing their keepers', () => {
    mergeEvidence('legacy', 'work', { deliveredTo: 'wt:unknown' });
    appendStatus('legacy', 'work', 'done');
    expect(readStats().perTrap[0]).toMatchObject({ name: 'wt:unknown', keepers: 1 });
  });

  it('caps trap labels only above 999', () => {
    expect([0, 12, 999, 1000, 12000].map(keeperCount)).toEqual(['0', '12', '999', '999+', '999+']);
  });
});
