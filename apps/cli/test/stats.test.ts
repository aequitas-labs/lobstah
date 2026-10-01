import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, ensureLayout, mergeEvidence } from '@lobstah/core';
import { readStats, statsOutput } from '../src/stats.js';
import { applyCull, planCull } from '../src/cull.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { catchCount } from '../src/glass-diff.js';
import { pollBody } from '../src/glass-poll.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const DAY = 86_400_000;
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
  // No active/done directories or registrations: the store alone suffices.
  for (const [id, lane, trap, verb] of [
    ['plan', 'work', 'a', 'done'], ['report', 'chore', 'a', 'done'],
    ['failure', 'work', 'a', 'failed'], ['cancelled', 'work', 'b', 'failed'],
    ['stowed', 'work', 'b', 'done'], ['headless', 'work', undefined, 'done'],
  ] as const) {
    mergeEvidence(id, lane, { ...(trap && { deliveredTo: `wt:${trap}` }), deliveredAt: '2026-09-01T00:00:00Z' });
    appendStatus(id, lane, verb, verb === 'failed' ? 'cancelled before claim' : 'finished');
  }
}

const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'stats', ...args], { encoding: 'utf8', env: process.env });

describe('lobstah stats', () => {
  it('counts every dispatch finished done, today and in total; per trap under its name', () => {
    fixture();
    expect(readStats()).toEqual({
      catchesToday: 4,
      totalCatches: 4,
      perTrap: [{ name: 'kind-crab', catches: 2 }, { name: 'stowed-crab', catches: 1 }],
    });
  });

  it('prints catches only by default; --per-trap adds the breakdown', () => {
    fixture();
    const plain = run();
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.trim()).toBe('catchesToday: 4\ntotalCatches: 4');
    const perTrap = run('--per-trap');
    expect(perTrap.stdout.trim()).toBe('catchesToday: 4\ntotalCatches: 4\nperTrap[2]{name,catches}:\n  kind-crab,2\n  stowed-crab,1');
    expect(JSON.parse(run('--json').stdout)).toEqual({ catchesToday: 4, totalCatches: 4 });
    expect(JSON.parse(run('--json', '--per-trap').stdout)).toEqual(JSON.parse(statsOutput(readStats(), { json: true, perTrap: true })));
    expect(plain.stdout + perTrap.stdout).not.toMatch(/keeper|traps:/);
  });

  it('cull removes old done entries and the totals stay the same', () => {
    fixture();
    const old = new Date(Date.now() - 30 * DAY);
    for (const id of ['plan', 'stowed', 'headless', 'failure']) {
      fs.mkdirSync(path.join(home, 'done', id));
      fs.utimesSync(path.join(home, 'done', id), old, old);
      for (const ext of ['status', 'evidence']) fs.utimesSync(path.join(home, 'state', `${id}.${ext}`), old, old);
    }
    const before = readStats();
    const plan = planCull(14);
    expect(plan.filter((i) => i.kind === 'done').map((i) => i.id).sort()).toEqual(['failure', 'headless', 'plan', 'stowed']);
    applyCull(plan);
    for (const id of ['plan', 'stowed', 'headless']) {
      expect(fs.existsSync(path.join(home, 'done', id))).toBe(false);
      expect(fs.existsSync(path.join(home, 'state', `${id}.status`))).toBe(false);
    }
    expect(readStats()).toEqual(before);
    // The store keeps de-duplication ids only for state still on disk.
    expect(JSON.parse(fs.readFileSync(path.join(home, 'stats.json'), 'utf8')).counted.sort()).toEqual(['report']);
  });

  it('a first run after an earlier cull backfills from the pre-cull backup without double counting', () => {
    fixture();
    // Simulate a pre-store install: a backup of state, then a cull that predates stats.json.
    fs.cpSync(path.join(home, 'state'), path.join(home, 'state-backup-20261001'), { recursive: true });
    fs.rmSync(path.join(home, 'stats.json'));
    for (const ext of ['status', 'evidence']) fs.rmSync(path.join(home, 'state', `plan.${ext}`));
    expect(readStats()).toMatchObject({ totalCatches: 4, perTrap: [{ name: 'kind-crab', catches: 2 }, { name: 'stowed-crab', catches: 1 }] });
  });

  it('glass gets today and the total, each trap its own, and a new catch changes the poll ETag', () => {
    fixture();
    const full = buildGlassSnapshot();
    expect(full.stats).toEqual({ catchesToday: 4, totalCatches: 4 });
    expect(full.traps.find((t) => t.name === 'stowed-crab')).toMatchObject({ live: false, totalCatches: 1 });
    const first = pollBody(full, Date.now());
    expect(JSON.parse(first.body).stats).toEqual({ catchesToday: 4, totalCatches: 4 });
    expect(pollBody({ ...full, now: new Date().toISOString() }, Date.now()).hash).toBe(first.hash);
    appendStatus('failure', 'work', 'done', 'recovered');
    const next = buildGlassSnapshot();
    expect(next.stats?.catchesToday).toBe(5);
    expect(pollBody(next, Date.now()).hash).not.toBe(first.hash);
  });

  it('keeps catches of a trap with no known name under its address', () => {
    mergeEvidence('legacy', 'work', { deliveredTo: 'wt:unknown' });
    appendStatus('legacy', 'work', 'done');
    expect(readStats().perTrap[0]).toEqual({ name: 'wt:unknown', catches: 1 });
  });

  it('caps trap badges only above 999', () => {
    expect([0, 12, 999, 1000, 12000].map(catchCount)).toEqual(['0', '12', '999', '999+', '999+']);
  });
});
