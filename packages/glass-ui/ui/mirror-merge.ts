import type { GlassSettings, GlassSnapshot, GlassViewer, StatsPage } from '@lobstah/core';

/**
 * Several mirror boats as one fleet. Each boat puts its own glass snapshot;
 * the hosted glass lays them side by side, as the local glass lays a
 * wharf's jobs beside its own. With one boat the snapshot is shown as the
 * boat's glass shows it. With two or more, every row says its boat's name
 * (on its repo or grounds, the field each list already shows), and the
 * router remembers which boat each row came from, so a read or a write
 * goes to that boat and no other.
 */

/** One boat's latest snapshot, as the wharf lists it. */
export interface MirrorBoatSnapshot {
  boat: string;
  name: string;
  /** When the boat put it. */
  at: string;
  etag: string;
  snapshot: GlassSnapshot;
}

/** A boat as the header shows it: its name, how old its snapshot is, and whether that is too old to act on. */
export interface MirrorBoatView {
  boat: string;
  name: string;
  at: string;
  ageSecs: number;
  stale: boolean;
}

/** A boat whose snapshot is older than this is off or asleep: its rows show, read-only. */
export const MIRROR_STALE_MS = 120_000;

/** What a merge gives: the snapshot the glass renders, the boats it holds, and where each row's calls go. */
export interface MirrorMerge {
  snapshot: GlassSnapshot;
  boats: MirrorBoatView[];
  router: MirrorRouter;
}

/** Where a read or write goes, once the labels the merge added are taken back off. */
export interface MirrorRoute<T> {
  /** The one boat it names; undefined when it names none, or several. */
  boat?: string;
  /** It names rows of more than one boat. */
  ambiguous?: boolean;
  value: T;
}

/**
 * Which boat each row came from. Labels are the strings the merge wrote
 * (`north · lobstah`); ids are the rows' own keys (dispatch ids, decision
 * keys, trap ids), which differ from boat to boat.
 */
export class MirrorRouter {
  private labels = new Map<string, { boat: string; value: string | undefined }>();
  private ids = new Map<string, Set<string>>();
  constructor(
    /** The only boat, when there is one: it takes every call that names none. */
    readonly only: string | undefined,
  ) {}
  /** A row's field, labelled with its boat's name. */
  label(boat: string, name: string, value: string | undefined): string {
    const shown = value === undefined || value === '' ? name : `${name} · ${value}`;
    this.labels.set(shown, { boat, value });
    return shown;
  }
  /** A row's own key, which a call names to reach it. */
  id(boat: string, value: unknown): void {
    if (typeof value !== 'string' || !value) return;
    const boats = this.ids.get(value) ?? new Set<string>();
    boats.add(boat);
    this.ids.set(value, boats);
  }
  /** The boat a call names, and the call as its boat knows it: every label taken back to the boat's own value. */
  resolve<T>(value: T): MirrorRoute<T> {
    const named = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const labelled = this.labels.get(v);
        if (labelled) {
          named.add(labelled.boat);
          return labelled.value;
        }
        for (const boat of this.ids.get(v) ?? []) named.add(boat);
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, inner] of Object.entries(v)) {
          const mapped = walk(inner);
          if (mapped !== undefined) out[k] = mapped;
        }
        return out;
      }
      return v;
    };
    const mapped = walk(value) as T;
    if (named.size > 1) return { ambiguous: true, value: mapped };
    const [boat] = named;
    return { boat: boat ?? this.only, value: mapped };
  }
}

/** The lists whose rows the router learns, by the fields that key them. */
const KEYED: ReadonlyArray<keyof GlassSnapshot> = [
  'dispatches',
  'traps',
  'attention',
  'decisions',
  'reports',
  'reviews',
  'prs',
  'stacks',
  'landed',
  'notices',
  'watches',
  'sessionGrants',
  'standingGrants',
  'helms',
  'todos',
  'configuredTraps',
  'recentRuns',
];
const KEY_FIELDS = ['id', 'key', 'trapId', 'url', 'sessionId', 'dispatch', 'profile'];
/** The lists concatenated across boats. */
const LISTS: ReadonlyArray<keyof GlassSnapshot> = [
  'usageLimits',
  'helmPasses',
  'goals',
  'backends',
  'helms',
  'traps',
  'configuredTraps',
  'notices',
  'watches',
  'dispatches',
  'prs',
  'stacks',
  'attention',
  'landed',
  'reports',
  'reviews',
  'sessionGrants',
  'standingGrants',
  'todos',
  'decisions',
  'recentRuns',
];
/** The fields that say a row's place, labelled with its boat when there are several: [list, field, label even when empty]. */
const LABELLED: ReadonlyArray<[keyof GlassSnapshot, string, boolean]> = [
  ['usageLimits', 'account', true],
  ['dispatches', 'repo', true],
  ['traps', 'repo', true],
  ['attention', 'repo', true],
  ['decisions', 'repo', true],
  ['recentRuns', 'repo', false],
  ['reports', 'repo', false],
  ['landed', 'repo', false],
  ['helms', 'grounds', false],
  ['todos', 'grounds', false],
  ['goals', 'grounds', false],
  ['helmPasses', 'grounds', false],
  ['backends', 'grounds', false],
  ['configuredTraps', 'grounds', false],
];

type Row = Record<string, unknown>;
const rows = (snapshot: GlassSnapshot, list: keyof GlassSnapshot): Row[] => (snapshot[list] as unknown as Row[] | undefined) ?? [];

/**
 * Merge every boat's snapshot into the one the glass renders. `probed` is
 * the boat this browser runs on, when the local glass answered the probe:
 * only its traps can raise a window from here. `viewer` is the page's own.
 */
export function mergeMirror(sources: readonly MirrorBoatSnapshot[], now: number, viewer: GlassViewer, probed?: string): MirrorMerge {
  const boats = sources.map((s): MirrorBoatView => {
    const ageMs = Math.max(0, now - Date.parse(s.at));
    return { boat: s.boat, name: s.name, at: s.at, ageSecs: Math.round(ageMs / 1000), stale: ageMs > MIRROR_STALE_MS };
  });
  const router = new MirrorRouter(sources.length === 1 ? sources[0]!.boat : undefined);
  const several = sources.length > 1;
  const parts = sources.map((s, i) => {
    const copy = JSON.parse(JSON.stringify(s.snapshot)) as GlassSnapshot & { mirror?: unknown };
    delete copy.mirror;
    delete copy.focusToken;
    // An asleep boat says so on every row it labels.
    const name = boats[i]!.stale ? `${s.name} (asleep)` : s.name;
    for (const list of KEYED) for (const row of rows(copy, list)) for (const field of KEY_FIELDS) router.id(s.boat, row[field]);
    if (several) {
      for (const [list, field, always] of LABELLED) {
        for (const row of rows(copy, list)) {
          const value = row[field];
          if (typeof value === 'string' || (always && value === undefined))
            row[field] = router.label(s.boat, name, value as string | undefined);
        }
      }
      if (copy.repoKeys) copy.repoKeys = copy.repoKeys.map((k) => router.label(s.boat, name, k));
    }
    // A run card runs on its own boat: the card names it.
    for (const d of copy.decisions ?? []) if (d.run) d.run.boat = s.name;
    // Only the boat this browser runs on raises its traps' windows; every other trap runs elsewhere.
    for (const trap of copy.traps) if (s.boat !== probed && (several || probed !== undefined)) trap.boat ??= s.name;
    return copy;
  });
  const first = parts[0];
  const snapshot: GlassSnapshot = {
    now: new Date(now).toISOString(),
    version: first?.version ?? '',
    repoUrl: first?.repoUrl ?? '',
    helms: [],
    traps: [],
    notices: [],
    watches: [],
    dispatches: [],
    prs: [],
    stacks: [],
    attention: [],
    landed: [],
    reports: [],
    attentionKinds: [...new Set(parts.flatMap((p) => p.attentionKinds))],
    viewer: {
      ...viewer,
      onMachine: probed !== undefined,
      machine: probed !== undefined ? (sources.find((s) => s.boat === probed)?.name ?? '') : several ? '' : (sources[0]?.name ?? ''),
    },
  };
  const target = snapshot as unknown as Record<string, unknown[] | undefined>;
  for (const list of LISTS) {
    const merged = parts.flatMap((p) => rows(p, list));
    if (merged.length || parts.some((p) => p[list] !== undefined)) target[list] = merged;
  }
  // A PR two boats both watch shows once.
  snapshot.prs = [...new Map(snapshot.prs.map((pr) => [pr.url, pr])).values()];
  if (parts.length === 1) return { snapshot: { ...parts[0]!, viewer: snapshot.viewer, now: parts[0]!.now }, boats, router };
  snapshot.trapNames = Object.assign({}, ...parts.map((p) => p.trapNames ?? {}));
  snapshot.reviewTools = Object.assign({}, ...parts.map((p) => p.reviewTools ?? {}));
  snapshot.repoKeys = parts.flatMap((p) => p.repoKeys ?? []);
  snapshot.helmOn = parts.some((p) => p.helmOn);
  const sum = <K extends 'stats' | 'slots'>(key: K) => {
    const present = parts.map((p) => p[key]).filter((v): v is NonNullable<GlassSnapshot[K]> => v !== undefined);
    if (!present.length) return undefined;
    const out: Record<string, number> = {};
    for (const v of present) for (const [k, n] of Object.entries(v)) if (typeof n === 'number') out[k] = (out[k] ?? 0) + n;
    return out as unknown as GlassSnapshot[K];
  };
  snapshot.stats = sum('stats');
  snapshot.slots = sum('slots');
  const older = parts.map((p) => p.older).filter((o): o is NonNullable<typeof o> => !!o);
  if (older.length) {
    const out: Record<string, number> = {};
    for (const o of older) for (const [k, n] of Object.entries(o)) out[k] = (out[k] ?? 0) + n;
    snapshot.older = out as NonNullable<GlassSnapshot['older']>;
  }
  for (const key of ['heavy', 'reviewSetup', 'mergeView', 'answerLimits'] as const) {
    const found = parts.find((p) => p[key] !== undefined)?.[key];
    if (found !== undefined) (snapshot as unknown as Record<string, unknown>)[key] = found;
  }
  const notes = parts.map((p, i) => p.todoNote && `${sources[i]!.name}: ${p.todoNote}`).filter(Boolean);
  if (notes.length) snapshot.todoNote = notes.join(' · ');
  const errors = parts.map((p, i) => p.attentionError && `${sources[i]!.name}: ${p.attentionError}`).filter(Boolean);
  if (errors.length) snapshot.attentionError = errors.join(' · ');
  // Newest first across boats, as each boat lists its own.
  const newest = (a: Row, b: Row, field: string) => String(b[field] ?? '').localeCompare(String(a[field] ?? ''));
  snapshot.notices.sort((a, b) => newest(a as unknown as Row, b as unknown as Row, 'at'));
  snapshot.reports.sort((a, b) => newest(a as unknown as Row, b as unknown as Row, 'at'));
  snapshot.decisions?.sort((a, b) => newest(a as unknown as Row, b as unknown as Row, 'askedAt'));
  return { snapshot, boats, router };
}

/** Each boat's settings under its own name: one section per boat, as each boat's glass shows them. */
export function mergeSettings(pages: ReadonlyArray<{ name: string; settings: GlassSettings }>): GlassSettings {
  if (pages.length === 1) return pages[0]!.settings;
  const at = (name: string, text: string) => `${name} · ${text}`;
  return {
    file: pages.map((p) => `${p.name}: ${p.settings.file}`).join('; '),
    ...(pages.some((p) => p.settings.error)
      ? {
          error: pages
            .filter((p) => p.settings.error)
            .map((p) => `${p.name}: ${p.settings.error}`)
            .join('; '),
        }
      : {}),
    versions: {
      rows: pages.flatMap((p) => p.settings.versions.rows.map((r) => ({ ...r, name: at(p.name, r.name) }))),
      match: pages.every((p) => p.settings.versions.match),
      text: pages.map((p) => `${p.name}: ${p.settings.versions.text}`).join('; '),
    },
    grounds: pages.flatMap((p) => p.settings.grounds.map((g) => ({ ...g, name: at(p.name, g.name) }))),
    repos: pages.flatMap((p) => p.settings.repos.map((r) => ({ ...r, key: at(p.name, r.key) }))),
    sections: pages.flatMap((p) => p.settings.sections.map((s) => ({ ...s, title: at(p.name, s.title) }))),
  };
}

/**
 * The fleet's catches across boats: the days added up, every trap under its
 * boat's name. The heatmap's levels are drawn again against the new busiest
 * day.
 */
export function mergeStats(pages: ReadonlyArray<{ name: string; stats: StatsPage }>): StatsPage {
  if (pages.length === 1) return pages[0]!.stats;
  const base = JSON.parse(JSON.stringify(pages[0]!.stats)) as StatsPage;
  const counts = new Map<string, number>();
  for (const p of pages)
    for (const week of p.stats.weeks) for (const day of week) counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
  const max = Math.max(0, ...counts.values());
  const level = (n: number): 0 | 1 | 2 | 3 | 4 => (n <= 0 || max === 0 ? 0 : (Math.min(4, Math.ceil((n / max) * 4)) as 1 | 2 | 3 | 4));
  base.weeks = base.weeks.map((week) =>
    week.map((day) => ({ ...day, count: counts.get(day.date) ?? 0, level: level(counts.get(day.date) ?? 0) })),
  );
  base.max = max;
  for (const key of ['catchesToday', 'catchesThisWeek', 'totalCatches', 'undated'] as const)
    base[key] = pages.reduce((n, p) => n + p.stats[key], 0);
  base.perTrap = pages
    .flatMap((p) => p.stats.perTrap.map((t) => ({ ...t, name: `${p.name} · ${t.name}` })))
    .sort((a, b) => b.catches - a.catches);
  const froms = pages
    .map((p) => p.stats.historyFrom)
    .filter((d): d is string => !!d)
    .sort();
  base.historyFrom = froms[0] ?? null;
  return base;
}
