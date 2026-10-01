import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout, mergeEvidence } from '../src/index.js';
import { foldCatches, localDay, readStatsStore, recordCatch, statsPath, statsView } from '../src/stats.js';
import type { StatsStore } from '../src/stats.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-core-stats-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const EARLIER = new Date(Date.now() - 2 * 86_400_000).toISOString();

/** Write a status log straight to disk, as an older lobstah (no store hook) would have. */
function legacy(dir: string, id: string, verbs: string[], at: string, trap?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.status`), verbs.map((verb) => JSON.stringify({ at, verb })).join('\n') + '\n');
  if (trap) fs.writeFileSync(path.join(dir, `${id}.evidence`), JSON.stringify({ deliveredTo: trap }));
}

describe('catch store', () => {
  it('backfills once from both lanes: done only, trap catches per trap, today by local day', () => {
    legacy(path.join(home, 'state'), 'plan', ['working', 'done'], EARLIER, 'wt:a');
    legacy(path.join(home, 'chores', 'state'), 'report', ['done'], new Date().toISOString(), 'wt:a');
    legacy(path.join(home, 'state'), 'headless', ['done'], new Date().toISOString());
    legacy(path.join(home, 'state'), 'broke', ['done', 'failed'], EARLIER, 'wt:b');
    legacy(path.join(home, 'state'), 'busy', ['working'], EARLIER, 'wt:b');
    const store = readStatsStore();
    expect(store).toMatchObject({ totalCatches: 3, catchesToday: 2, day: localDay(), perTrap: { 'wt:a': 2 } });
    expect(store.counted.sort()).toEqual(['headless', 'plan', 'report']);
    expect(fs.existsSync(statsPath())).toBe(true);
    // Once: a later legacy write is not rescanned.
    legacy(path.join(home, 'state'), 'later', ['done'], EARLIER);
    expect(readStatsStore().totalCatches).toBe(3);
  });

  it('reads a pre-cull state backup, de-duplicated by dispatch id', () => {
    legacy(path.join(home, 'state'), 'kept', ['done'], EARLIER, 'wt:a');
    const backup = path.join(home, 'state-backup-20261001');
    legacy(backup, 'kept', ['done'], EARLIER, 'wt:a');
    legacy(backup, 'culled', ['done'], EARLIER, 'wt:a');
    legacy(backup, 'culled-failed', ['failed'], EARLIER, 'wt:a');
    const store = readStatsStore();
    expect(store).toMatchObject({ totalCatches: 2, perTrap: { 'wt:a': 2 } });
    // A culled id never folds again, so it isn't kept for de-duplication.
    expect(store.counted).toEqual(['kept']);
  });

  it('counts a done report once, through appendStatus', () => {
    mergeEvidence('d1', 'work', { deliveredTo: 'wt:a' });
    appendStatus('d1', 'work', 'working');
    expect(readStatsStore().totalCatches).toBe(0);
    appendStatus('d1', 'work', 'done');
    appendStatus('d1', 'work', 'done');
    recordCatch('d1', 'work');
    expect(readStatsStore()).toMatchObject({ totalCatches: 1, catchesToday: 1, perTrap: { 'wt:a': 1 }, counted: ['d1'] });
  });

  it('a fold keeps counted catches and adds ones the hook missed', () => {
    appendStatus('hooked', 'work', 'done');
    legacy(path.join(home, 'state'), 'missed', ['done'], EARLIER, 'wt:b');
    legacy(path.join(home, 'state'), 'lost', ['failed'], EARLIER);
    foldCatches([{ id: 'hooked', lane: 'work' }, { id: 'missed', lane: 'work' }, { id: 'lost', lane: 'work' }]);
    expect(readStatsStore()).toMatchObject({ totalCatches: 2, catchesToday: 1, perTrap: { 'wt:b': 1 }, counted: [] });
  });

  it('today turns over at the local day; totals and names resolve on read', () => {
    const store: StatsStore = { version: 1, totalCatches: 7, perTrap: { 'wt:a': 3, 'wt:b': 2, 'wt:c': 1 }, day: '2020-01-01', catchesToday: 4, counted: [] };
    const names = new Map([['wt:a', 'kind-crab'], ['wt:b', 'kind-crab']]);
    expect(statsView(store, names)).toEqual({
      catchesToday: 0,
      totalCatches: 7,
      perTrap: [{ name: 'kind-crab', catches: 5 }, { name: 'wt:c', catches: 1 }],
    });
    expect(statsView({ ...store, day: localDay() }, names).catchesToday).toBe(4);
    fs.writeFileSync(statsPath(), JSON.stringify(store));
    appendStatus('new', 'work', 'done');
    expect(readStatsStore()).toMatchObject({ totalCatches: 8, day: localDay(), catchesToday: 1 });
  });

  it('sets an unreadable store aside and rebuilds it', () => {
    fs.writeFileSync(statsPath(), '{not json');
    appendStatus('d1', 'work', 'done');
    expect(readStatsStore().totalCatches).toBe(1);
    expect(fs.readdirSync(home).some((f) => f.startsWith('stats.json.unreadable-'))).toBe(true);
  });
});
