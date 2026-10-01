import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs, lobstahHome, readDirIfPresent } from './paths.js';
import type { Lane } from './types.js';

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
 */
export interface StatsStore {
  version: 1;
  totalCatches: number;
  /** Catches per trap, keyed by trap address (`wt:<trapId>`); names resolve on read. */
  perTrap: Record<string, number>;
  /** The local day (YYYY-MM-DD) `catchesToday` counts. */
  day: string;
  catchesToday: number;
  /**
   * Counted dispatches whose state is still on disk, so a repeated done or a
   * later fold never counts one twice. Cull drops an id as it folds it: the
   * store stays as small as the retained state.
   */
  counted: string[];
}

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
  try {
    const to = (JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.evidence`), 'utf8')) as { deliveredTo?: unknown }).deliveredTo;
    if (typeof to === 'string' && to.startsWith('wt:')) trap = to;
  } catch {
    /* no receipt: a headless catch */
  }
  return { done: true, ...(typeof last.at === 'string' ? { at: last.at } : {}), ...(trap ? { trap } : {}) };
}

function emptyStore(now: number): StatsStore {
  return { version: 1, totalCatches: 0, perTrap: {}, day: localDay(now), catchesToday: 0, counted: [] };
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
  const at = facts.at && Number.isFinite(Date.parse(facts.at)) ? facts.at : undefined;
  if ((at ? localDay(at) : today) === today) store.catchesToday++;
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
export function backfillStats(now = Date.now()): StatsStore {
  const store = emptyStore(now);
  const seen = new Set<string>();
  for (const { dir, live } of backfillSources()) {
    for (const file of readDirIfPresent(dir).sort()) {
      if (!file.endsWith('.status')) continue;
      const id = file.slice(0, -'.status'.length);
      if (seen.has(id)) continue;
      seen.add(id);
      const facts = readCatchFacts(dir, id);
      if (!facts.done) continue;
      add(store, facts, now);
      // A backup's ids are already culled: no later fold will drop them.
      if (live) store.counted.push(id);
    }
  }
  return store;
}

function parseStore(text: string): StatsStore | undefined {
  try {
    const s = JSON.parse(text) as Partial<StatsStore>;
    if (s.version !== 1 || typeof s.totalCatches !== 'number' || typeof s.catchesToday !== 'number' || typeof s.day !== 'string') return undefined;
    return { version: 1, totalCatches: s.totalCatches, perTrap: s.perTrap ?? {}, day: s.day, catchesToday: s.catchesToday, counted: s.counted ?? [] };
  } catch {
    return undefined;
  }
}

function writeStore(store: StatsStore): void {
  const file = statsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
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
  if (saved) return saved;
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
    if (saved) return saved;
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
