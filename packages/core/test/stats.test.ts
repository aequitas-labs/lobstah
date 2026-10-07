import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout, mergeEvidence } from '../src/index.js';
import { DAILY_RETENTION_DAYS, HEATMAP_WEEKS, foldCatches, heatLevel, localDay, readStatsStore, recordCatch, shiftDay, statsPage, statsPath, statsView } from '../src/stats.js';
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
    const store: StatsStore = { version: 1, totalCatches: 7, perTrap: { 'wt:a': 3, 'wt:b': 2, 'wt:c': 1 }, day: '2020-01-01', catchesToday: 4, counted: [], daily: {} };
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

/** Local noon on a local calendar day: the clock the store's `now` reads. */
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const NOW = noon(2026, 10, 7);
/** A done report at a local time, as its ISO string. */
const localAt = (y: number, m: number, d: number, h = 12, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).toISOString();
const readDaily = () => (JSON.parse(fs.readFileSync(statsPath(), 'utf8')) as StatsStore).daily;

describe('daily catch history', () => {
  it('counts a catch once on its local day, however often done is reported or folded', () => {
    legacy(path.join(home, 'state'), 'seed', ['working'], localAt(2026, 10, 7));
    readStatsStore(NOW); // the store exists before the catch
    legacy(path.join(home, 'state'), 'd1', ['working', 'done'], localAt(2026, 10, 6, 9));
    recordCatch('d1', 'work', NOW);
    recordCatch('d1', 'work', NOW);
    foldCatches([{ id: 'd1', lane: 'work' }], NOW);
    expect(readDaily()).toEqual({ '2026-10-06': 1 });
    expect(readStatsStore(NOW)).toMatchObject({ totalCatches: 1, catchesToday: 0 });
  });

  it('splits days at local midnight, not UTC', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      readStatsStore(NOW);
      // 23:59:59 and 00:00:01 local: two days. 04:00Z on the 7th is still the 6th in Los Angeles.
      legacy(path.join(home, 'state'), 'late', ['done'], localAt(2026, 10, 5, 23, 59, 59));
      legacy(path.join(home, 'state'), 'early', ['done'], localAt(2026, 10, 6, 0, 0, 1));
      legacy(path.join(home, 'state'), 'utc', ['done'], '2026-10-07T04:00:00.000Z');
      for (const id of ['late', 'early', 'utc']) recordCatch(id, 'work', noon(2026, 10, 7));
      expect(readDaily()).toEqual({ '2026-10-05': 1, '2026-10-06': 2 });
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it(`keeps ${DAILY_RETENTION_DAYS} days (more than a 53-week heatmap) and drops older ones; totals keep everything`, () => {
    expect(DAILY_RETENTION_DAYS).toBeGreaterThanOrEqual(371);
    const oldest = shiftDay(localDay(NOW), DAILY_RETENTION_DAYS - 1);
    const store: StatsStore = {
      version: 1, totalCatches: 3, perTrap: {}, day: localDay(NOW), catchesToday: 0, counted: [],
      daily: { [shiftDay(oldest, 1)]: 1, [oldest]: 1, [shiftDay(localDay(NOW), 371)]: 1 },
    };
    fs.writeFileSync(statsPath(), JSON.stringify(store));
    legacy(path.join(home, 'state'), 'ancient', ['done'], new Date(Date.parse(`${shiftDay(oldest, 3)}T12:00:00`)).toISOString());
    legacy(path.join(home, 'state'), 'fresh', ['done'], localAt(2026, 10, 7, 8));
    foldCatches([{ id: 'ancient', lane: 'work' }, { id: 'fresh', lane: 'work' }], NOW);
    expect(readDaily()).toEqual({ [oldest]: 1, [shiftDay(localDay(NOW), 371)]: 1, '2026-10-07': 1 });
    expect(readStatsStore(NOW)).toMatchObject({ totalCatches: 5, catchesToday: 1 });
  });

  it('backfills a store saved before per-day history once, from the done records still on disk', () => {
    const state = path.join(home, 'state');
    const backup = path.join(home, 'state-backup-20261001');
    legacy(state, 'counted', ['done'], localAt(2026, 10, 5, 10));
    legacy(state, 'uncounted', ['done'], localAt(2026, 10, 6, 10)); // the hook missed it: a fold counts it later
    legacy(state, 'failed', ['done', 'failed'], localAt(2026, 10, 6, 10));
    legacy(backup, 'counted', ['done'], localAt(2026, 10, 5, 10)); // the same dispatch: once
    legacy(backup, 'culled', ['done'], localAt(2026, 9, 22, 23, 30));
    // An older store: no daily, and catches whose records are gone entirely.
    const before = { version: 1, totalCatches: 10, perTrap: { 'wt:a': 4 }, day: '2026-10-07', catchesToday: 2, counted: ['counted'] };
    fs.writeFileSync(statsPath(), JSON.stringify(before));
    const store = readStatsStore(NOW);
    expect(store.daily).toEqual({ '2026-09-22': 1, '2026-10-05': 1 });
    // Existing fields keep their values and meaning.
    expect(store).toMatchObject({ totalCatches: 10, perTrap: { 'wt:a': 4 }, catchesToday: 2, counted: ['counted'] });
    // Once: a record that appears later is not rescanned into history.
    legacy(backup, 'late', ['done'], localAt(2026, 9, 30));
    expect(readStatsStore(NOW).daily).toEqual({ '2026-09-22': 1, '2026-10-05': 1 });
    // The missed catch counts once, on its own day, when cull folds it.
    foldCatches([{ id: 'uncounted', lane: 'work' }, { id: 'counted', lane: 'work' }], NOW);
    expect(readStatsStore(NOW)).toMatchObject({ totalCatches: 11, daily: { '2026-09-22': 1, '2026-10-05': 1, '2026-10-06': 1 } });
  });

  it('a first-ever store fills its daily history with the same backfill as the totals', () => {
    legacy(path.join(home, 'state'), 'a', ['done'], localAt(2026, 10, 1));
    legacy(path.join(home, 'state-backup-20261001'), 'b', ['done'], localAt(2026, 9, 30));
    legacy(path.join(home, 'state-backup-20261001'), 'a', ['done'], localAt(2026, 10, 1));
    expect(readStatsStore(NOW)).toMatchObject({ totalCatches: 2, daily: { '2026-09-30': 1, '2026-10-01': 1 } });
  });
});

describe('stats page', () => {
  const base = (daily: Record<string, number>, extra: Partial<StatsStore> = {}): StatsStore => ({
    version: 1, totalCatches: Object.values(daily).reduce((a, n) => a + n, 0), perTrap: {}, day: localDay(NOW), catchesToday: daily[localDay(NOW)] ?? 0, counted: [], daily, ...extra,
  });

  it('lays out 53 weeks, Sunday to Saturday, ending today, with month labels', () => {
    const page = statsPage(base({}), new Map(), NOW);
    expect(page.weeks).toHaveLength(HEATMAP_WEEKS);
    // 2026-10-07 is a Wednesday: the last column runs Sunday the 4th to today.
    expect(page.weeks.at(-1)!.map((d) => d.date)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(page.weeks[0]![0]!.date).toBe('2025-10-05');
    expect(page.weeks.slice(0, -1).every((w) => w.length === 7)).toBe(true);
    const all = page.weeks.flat().map((d) => d.date);
    expect(all.every((d, i) => i === 0 || shiftDay(all[i - 1]!, -1) === d)).toBe(true);
    expect(page.months.map((m) => m.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(page.months[0]).toEqual({ week: 0, label: 'Oct' });
    expect(page).toMatchObject({ totalCatches: 0, currentStreak: 0, longestStreak: 0, max: 0, undated: 0, historyFrom: null });
  });

  it('counts the week, both streaks, levels against the busiest day, and catches with no day', () => {
    const daily = { '2026-09-01': 1, '2026-09-02': 1, '2026-09-03': 8, '2026-09-04': 2, '2026-10-05': 4, '2026-10-06': 2, '2026-10-07': 1 };
    const page = statsPage(base(daily, { totalCatches: 25, perTrap: { 'wt:a': 3, 'wt:b': 5 } }), new Map([['wt:a', 'kind-crab']]), NOW);
    expect(page).toMatchObject({
      today: '2026-10-07', catchesToday: 1, catchesThisWeek: 7, totalCatches: 25, currentStreak: 3, longestStreak: 4,
      max: 8, undated: 6, historyFrom: '2026-09-01',
      perTrap: [{ name: 'wt:b', catches: 5 }, { name: 'kind-crab', catches: 3 }],
    });
    const level = (date: string) => page.weeks.flat().find((d) => d.date === date)!.level;
    expect(['2026-09-03', '2026-10-05', '2026-09-04', '2026-09-01', '2026-08-01'].map(level)).toEqual([4, 2, 1, 1, 0]);
    expect([0, 1, 2, 3, 4, 5, 8].map((n) => heatLevel(n, 8))).toEqual([0, 1, 1, 2, 2, 3, 4]);
  });

  it('a streak stays current until a whole day passes without a catch', () => {
    expect(statsPage(base({ '2026-10-05': 1, '2026-10-06': 1 }), new Map(), NOW).currentStreak).toBe(2);
    expect(statsPage(base({ '2026-10-05': 1 }), new Map(), NOW).currentStreak).toBe(0);
  });
});
