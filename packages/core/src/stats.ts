import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, laneDirs, lobstahHome, readDirIfPresent } from './paths.js';
import type { Lane } from './types.js';
import type { Evidence } from './types.js';
import { sanitizeWorker, workerProfile } from './worker-profile.js';
import type { WorkerProfile } from './worker-profile.js';
import { readTrap } from './soak.js';

export type WorkerCatches = WorkerProfile & { today: number };

/**
 * Catches: dispatches that finished done. The counts live in a small durable
 * store (`stats.json`) so they outlive `lobstah cull`, which deletes the
 * state files they were first read from.
 *
 * - A `done` report counts its dispatch once (appendStatus → recordCatch).
 * - Cull folds each dispatch whose state it removes into the store before
 *   deleting it (foldCatches), so a catch the report hook missed still counts.
 * - The first read with no store backfills from retained state and from any
 *   `state-backup-*` copy of a state dir, de-duplicated by dispatch id.
 * - `daily` counts catches per local day through the same path, so the same
 *   de-duplication covers it. A store saved before `daily` existed gets it
 *   once, from the done records still on disk (backfillDaily); a catch whose
 *   record is gone has no day, and stays in `totalCatches` only.
 */
export interface StatsStore {
  version: 1;
  totalCatches: number;
  /** Catches per trap, keyed by trap address (`wt:<trapId>`); names resolve on read. */
  perTrap: Record<string, number>;
  /** The local day (YYYY-MM-DD) `catchesToday` counts. */
  day: string;
  catchesToday: number;
  /** UTC-day counters for sharing; local-day glass/CLI stats stay unchanged. */
  utc?: { date: string; catches: number; perTrap: Record<string, number>; trapWorkers?: Record<string, WorkerProfile>; byWorker?: WorkerCatches[] };
  /**
   * Counted dispatches whose state is still on disk, so a repeated done or a
   * later fold never counts one twice. Cull drops an id as it folds it: the
   * store stays as small as the retained state.
   */
  counted: string[];
  /**
   * Catches per local day (YYYY-MM-DD → count), the last DAILY_RETENTION_DAYS
   * days. Days with no catch are absent.
   */
  daily: Record<string, number>;
}

/** How many local days `daily` keeps: at least the 53 weeks (371 days) a heatmap shows, and some slack. */
export const DAILY_RETENTION_DAYS = 400;

/** One trap's catches, under its persistent name (or `wt:<id>` with none). */
export interface TrapCatches {
  name: string;
  catches: number;
}

export interface Stats {
  catchesToday: number;
  totalCatches: number;
  perTrap: TrapCatches[];
}

/** A dispatch whose state cull is about to remove. */
export interface CatchRef {
  id: string;
  lane: Lane;
}

export function statsPath(): string {
  return path.join(lobstahHome(), 'stats.json');
}

/** The local calendar day `days` days before (or, negative, after) a local day. DST-safe: it steps calendar days. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d - days));
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function localDay(at: number | string | Date = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A dispatch's final state as its state files record it. */
interface CatchFacts {
  done: boolean;
  at?: string;
  trap?: string;
  worker?: WorkerProfile;
}

function readCatchFacts(stateDir: string, id: string): CatchFacts {
  let last: { verb?: unknown; at?: unknown } | undefined;
  try {
    for (const line of fs.readFileSync(path.join(stateDir, `${id}.status`), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        last = JSON.parse(line) as typeof last;
      } catch {
        /* a torn line: the entries around it still count */
      }
    }
  } catch {
    return { done: false };
  }
  if (last?.verb !== 'done') return { done: false };
  let trap: string | undefined;
  let worker = workerProfile();
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.evidence`), 'utf8')) as Evidence;
    const to = evidence.deliveredTo;
    if (typeof to === 'string' && to.startsWith('wt:')) trap = to;
    const reg = trap ? readTrap(trap.slice('wt:'.length)) : undefined;
    worker = sanitizeWorker(reg ?? evidence.worker ?? workerProfile({ harness: evidence.harness }));
  } catch {
    /* no receipt: a headless catch */
  }
  return { done: true, worker, ...(typeof last.at === 'string' ? { at: last.at } : {}), ...(trap ? { trap } : {}) };
}

function emptyStore(now: number): StatsStore {
  return {
    version: 1, totalCatches: 0, perTrap: {}, day: localDay(now), catchesToday: 0, counted: [], daily: {},
    utc: { date: new Date(now).toISOString().slice(0, 10), catches: 0, perTrap: {}, trapWorkers: {}, byWorker: [] },
  };
}

/** The local day a catch counts on: its done report's, else now's. */
function catchDay(facts: CatchFacts, now: number): string {
  return facts.at && Number.isFinite(Date.parse(facts.at)) ? localDay(facts.at) : localDay(now);
}

/** Count a catch on its local day, unless that day is past retention. */
function addDaily(store: StatsStore, day: string, now: number): void {
  if (day < shiftDay(localDay(now), DAILY_RETENTION_DAYS - 1)) return;
  store.daily[day] = (store.daily[day] ?? 0) + 1;
}

/** Drop days past retention. */
function pruneDaily(store: StatsStore, now: number): void {
  const oldest = shiftDay(localDay(now), DAILY_RETENTION_DAYS - 1);
  for (const day of Object.keys(store.daily)) if (day < oldest) delete store.daily[day];
}

/** Count one catch into the store. */
function add(store: StatsStore, facts: CatchFacts, now: number): void {
  store.totalCatches++;
  if (facts.trap) store.perTrap[facts.trap] = (store.perTrap[facts.trap] ?? 0) + 1;
  const today = localDay(now);
  if (store.day !== today) {
    store.day = today;
    store.catchesToday = 0;
  }
  const day = catchDay(facts, now);
  if (day === today) store.catchesToday++;
  addDaily(store, day, now);
  pruneDaily(store, now);
  const at = facts.at && Number.isFinite(Date.parse(facts.at)) ? facts.at : undefined;
  const utcDay = new Date(now).toISOString().slice(0, 10);
  if (store.utc?.date !== utcDay) store.utc = { date: utcDay, catches: 0, perTrap: {}, trapWorkers: {}, byWorker: [] };
  if ((at ? new Date(at).toISOString().slice(0, 10) : utcDay) === utcDay) {
    store.utc.catches++;
    const worker = sanitizeWorker(facts.worker);
    if (facts.trap) {
      store.utc.perTrap[facts.trap] = (store.utc.perTrap[facts.trap] ?? 0) + 1;
      (store.utc.trapWorkers ??= {})[facts.trap] = worker;
    } else {
      const rows = store.utc.byWorker ??= [];
      const key = JSON.stringify(worker);
      const row = rows.find((r) => JSON.stringify(sanitizeWorker(r)) === key);
      if (row) row.today++;
      else rows.push({ ...worker, today: 1 });
    }
  }
}

/** Retained state dirs, live lanes first so they win over any backup copy. */
function backfillSources(): Array<{ dir: string; live: boolean }> {
  const live = (['work', 'chore'] as const).map((lane) => ({ dir: laneDirs(lane).state, live: true }));
  const backups = readDirIfPresent(lobstahHome())
    .filter((name) => name.startsWith('state-backup-'))
    .sort()
    .map((name) => ({ dir: path.join(lobstahHome(), name), live: false }))
    .filter((s) => fs.statSync(s.dir).isDirectory());
  return [...live, ...backups];
}

/** Build the store from history: every retained or backed-up dispatch that finished done, once. */
export function backfillStats(now = Date.now(), alreadyCounted?: ReadonlySet<string>): StatsStore {
  const store = emptyStore(now);
  const seen = new Set<string>();
  for (const { dir, live } of backfillSources()) {
    for (const file of readDirIfPresent(dir).sort()) {
      if (!file.endsWith('.status')) continue;
      const id = file.slice(0, -'.status'.length);
      if (seen.has(id)) continue;
      seen.add(id);
      // During an upgrade, a newly written done report may not yet be in
      // the saved store. Its record/fold will add it, including UTC counts.
      if (live && alreadyCounted && !alreadyCounted.has(id)) continue;
      const facts = readCatchFacts(dir, id);
      if (!facts.done) continue;
      add(store, facts, now);
      // A backup's ids are already culled: no later fold will drop them.
      if (live) store.counted.push(id);
    }
  }
  return store;
}

/**
 * Give a store saved before `daily` existed its per-day history, once: each
 * dispatch that finished done and whose record is still on disk counts on
 * the local day of its done report. Live state comes first, then each
 * `state-backup-*`, one count per dispatch id. A live done the store has not
 * counted yet is skipped: recordCatch or a fold counts it (and its day) later.
 * A catch whose record was culled has no day; it stays in the totals only.
 */
export function backfillDaily(store: StatsStore, now = Date.now()): StatsStore {
  const daily: Record<string, number> = {};
  const counted = new Set(store.counted);
  const seen = new Set<string>();
  const into = { ...store, daily };
  for (const { dir, live } of backfillSources()) {
    for (const file of readDirIfPresent(dir).sort()) {
      if (!file.endsWith('.status')) continue;
      const id = file.slice(0, -'.status'.length);
      if (seen.has(id)) continue;
      seen.add(id);
      if (live && !counted.has(id)) continue;
      const facts = readCatchFacts(dir, id);
      if (facts.done) addDaily(into, catchDay(facts, now), now);
    }
  }
  pruneDaily(into, now);
  return into;
}

const isDaily = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((n) => typeof n === 'number');

/** A saved store; `daily` is undefined when it predates per-day history. */
function parseStore(text: string): (Omit<StatsStore, 'daily'> & { daily?: Record<string, number> }) | undefined {
  try {
    const s = JSON.parse(text) as Partial<StatsStore>;
    if (s.version !== 1 || typeof s.totalCatches !== 'number' || typeof s.catchesToday !== 'number' || typeof s.day !== 'string') return undefined;
    return {
      version: 1,
      totalCatches: s.totalCatches,
      perTrap: s.perTrap ?? {},
      day: s.day,
      catchesToday: s.catchesToday,
      counted: s.counted ?? [],
      ...(isDaily(s.daily) ? { daily: s.daily } : {}),
      ...(s.utc ? { utc: s.utc } : {}),
    };
  } catch {
    return undefined;
  }
}

const complete = (s: ReturnType<typeof parseStore>): s is StatsStore => !!s && s.daily !== undefined;

function writeStore(store: StatsStore): void {
  const file = statsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
}

/** One process at a time changes the store; a crashed holder's lock goes stale after two minutes. */
function withStatsLock<T>(action: () => T): T {
  fs.mkdirSync(lobstahHome(), { recursive: true });
  const lock = `${statsPath()}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
      } catch {
        /* another process removed it first */
      }
      if (Date.now() >= deadline) throw new Error('stats store locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.rmdirSync(lock);
  }
}

/** The store as saved; with none (or an unreadable one), backfilled once and saved. Call under the lock. */
function loadOrBackfill(now: number): StatsStore {
  let text: string | undefined;
  try {
    text = fs.readFileSync(statsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const saved = text === undefined ? undefined : parseStore(text);
  if (complete(saved) && saved.utc?.trapWorkers !== undefined && saved.utc.byWorker !== undefined) return saved;
  if (saved) {
    // Upgrade local history and UTC counters independently; never reset a
    // present history or all-time totals that include culled dispatches.
    const store = complete(saved) ? saved : backfillDaily({ ...saved, daily: {} }, now);
    if (!store.utc) {
      // Upgrade only the new UTC counters from retained history; never reset
      // all-time totals that already include culled dispatches.
      store.utc = backfillStats(now, new Set(store.counted)).utc!;
    }
    if (store.utc.trapWorkers === undefined || store.utc.byWorker === undefined) {
      const history = backfillStats(now, new Set(store.counted)).utc;
      if (history?.date === store.utc.date) {
        store.utc.trapWorkers ??= history.trapWorkers ?? {};
        store.utc.byWorker ??= history.byWorker ?? [];
      } else {
        store.utc.trapWorkers ??= {};
        store.utc.byWorker ??= [];
      }
    }
    writeStore(store);
    return store;
  }
  // Keep an unreadable store for inspection rather than overwriting it silently.
  if (text !== undefined) fs.renameSync(statsPath(), `${statsPath()}.unreadable-${now}`);
  const store = backfillStats(now);
  writeStore(store);
  return store;
}

/** The saved store, backfilling it on first use. */
export function readStatsStore(now = Date.now()): StatsStore {
  try {
    const saved = parseStore(fs.readFileSync(statsPath(), 'utf8'));
    if (complete(saved) && saved.utc?.trapWorkers !== undefined && saved.utc.byWorker !== undefined) return saved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return withStatsLock(() => loadOrBackfill(now));
}

/** A dispatch finished done: count it, once. */
export function recordCatch(id: string, lane: Lane, now = Date.now()): void {
  withStatsLock(() => {
    const store = loadOrBackfill(now);
    if (store.counted.includes(id)) return;
    const facts = readCatchFacts(laneDirs(lane).state, id);
    if (!facts.done) return;
    add(store, facts, now);
    store.counted.push(id);
    writeStore(store);
  });
}

/**
 * Cull is about to delete these dispatches' state: keep their catches. One
 * already counted only leaves the de-duplication list; one never counted (a
 * done written before the store existed, or by a path the hook missed) is
 * added now.
 */
export function foldCatches(refs: readonly CatchRef[], now = Date.now()): void {
  if (refs.length === 0) return;
  withStatsLock(() => {
    const store = loadOrBackfill(now);
    const counted = new Set(store.counted);
    for (const { id, lane } of refs) {
      if (counted.delete(id)) continue;
      const facts = readCatchFacts(laneDirs(lane).state, id);
      if (facts.done) add(store, facts, now);
    }
    store.counted = [...counted];
    writeStore(store);
  });
}

/**
 * What a reader shows: today's catches (zero once the local day turns), the
 * total, and each trap's total under its current name. Names reused across
 * worktrees combine; an address with no known name stays `wt:<id>`.
 */
export function statsView(store: StatsStore, names: ReadonlyMap<string, string>, now = Date.now()): Stats {
  const perTrap = new Map<string, number>();
  for (const [address, n] of Object.entries(store.perTrap)) {
    const name = names.get(address) ?? address;
    perTrap.set(name, (perTrap.get(name) ?? 0) + n);
  }
  return {
    catchesToday: store.day === localDay(now) ? store.catchesToday : 0,
    totalCatches: store.totalCatches,
    perTrap: [...perTrap].map(([name, catches]) => ({ name, catches })).sort((a, b) => b.catches - a.catches || a.name.localeCompare(b.name)),
  };
}

/** One heatmap cell: a local day, its catches, and its intensity step (0 = none, 4 = most). */
export interface StatsDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

/** What the glass's Stats tab shows (`GET /data/stats`). */
export interface StatsPage {
  /** The local day the page was built for. */
  today: string;
  catchesToday: number;
  /** Catches since Sunday, local time: the heatmap's last column. */
  catchesThisWeek: number;
  totalCatches: number;
  /** HEATMAP_WEEKS columns, oldest first; each Sunday → Saturday, the last ending today. */
  weeks: StatsDay[][];
  /** A month label over the column where that month starts. */
  months: Array<{ week: number; label: string }>;
  /** The most catches on one heatmap day: what level 4 means. */
  max: number;
  /** Each trap's all-time catches, most first (the store keeps no per-day split). */
  perTrap: TrapCatches[];
  /** Catches with no recorded day: culled before per-day history began, or past retention. */
  undated: number;
  /** The earliest day with a recorded catch, if any. */
  historyFrom: string | null;
}

export const HEATMAP_WEEKS = 53;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const weekday = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getDay();
};

/** A count's intensity step against the busiest day: 0 for none, else 1 to 4 in equal quarters. */
export function heatLevel(count: number, max: number): StatsDay['level'] {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as StatsDay['level'];
}

/** The Stats tab's numbers and heatmap, from the store. Read-only. */
export function statsPage(store: StatsStore, names: ReadonlyMap<string, string>, now = Date.now()): StatsPage {
  const view = statsView(store, names, now);
  const today = localDay(now);
  const count = (day: string) => store.daily[day] ?? 0;
  const start = shiftDay(today, weekday(today) + (HEATMAP_WEEKS - 1) * 7);
  const dates: string[][] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      const date = shiftDay(start, -(w * 7 + d));
      if (date > today) break;
      week.push(date);
    }
    dates.push(week);
  }
  const max = Math.max(0, ...dates.flat().map(count));
  const weeks = dates.map((week) => week.map((date) => ({ date, count: count(date), level: heatLevel(count(date), max) })));
  const months: StatsPage['months'] = [];
  dates.forEach((week, w) => {
    const month = Number(week[0]!.slice(5, 7)) - 1;
    if (w === 0 || month !== Number(dates[w - 1]![0]!.slice(5, 7)) - 1) months.push({ week: w, label: MONTHS[month]! });
  });
  // A first label squeezed against the next one would overlap it.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  const recorded = Object.keys(store.daily).filter((d) => store.daily[d]! > 0 && d <= today);
  const dated = Object.values(store.daily).reduce((a, n) => a + n, 0);
  return {
    today,
    catchesToday: view.catchesToday,
    catchesThisWeek: weeks[weeks.length - 1]!.reduce((a, d) => a + d.count, 0),
    totalCatches: view.totalCatches,
    weeks,
    months,
    max,
    perTrap: view.perTrap,
    undated: Math.max(0, store.totalCatches - dated),
    historyFrom: recorded.length ? recorded.sort()[0]! : null,
  };
}
