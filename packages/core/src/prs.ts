import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';
import { parsePrRef, prStandingKinds } from './pr.js';
import type { PrEvidence, PrStandingKind } from './pr.js';

/**
 * PR records: PR state keyed by the PR, not by whichever dispatch reported
 * it. `~/.lobstah/prs/<owner>__<repo>__<n>.json` holds the latest
 * observation of one PR — the same object the pr: preset stamps into a
 * dispatch's evidence — plus the ids of every dispatch whose watch observed
 * it. A man-owned watch (a human's PR, or one whose dispatch was culled)
 * has no dispatch evidence to stamp, so the record is the only place its
 * state lives; tend, the glass, and the merged/closed notice all read
 * records first and fall back to dispatch evidence only for a PR that has
 * no record yet.
 *
 * One writer: the preset's observation path (apps/cli/src/pr-watch.ts).
 */

export interface PrRecord extends PrEvidence {
  /** `pr:<owner>/<repo>#<n>`. */
  key: string;
  /** The forge repo, `<owner>/<repo>`. */
  repo: string;
  /** Dispatches whose pr: watch observed this PR, oldest first; empty for an untracked/human PR. */
  dispatches: string[];
  /** First observation of each currently standing kind; absent kinds have cleared. */
  standingSince: Partial<Record<PrStandingKind, string>>;
  /** Number of observations. The first is a baseline, never a repair trigger. */
  observations?: number;
  /**
   * The first observation's time. Written once, never rewritten. Absent on a
   * record written before this field existed until its next observation.
   */
  firstSeenAt?: string;
  /** When the current head sha was first observed. */
  headSince?: string;
  /** When the current base branch and base head were first observed. */
  baseSince?: string;
  /** When the current set of failing check runs was first observed; absent when no check fails. */
  failingSince?: string;
  /** Checks a worker named as human gates on this PR (`report --human-gate`). */
  humanGates?: string[];
  /**
   * Consecutive lobstah repairs that made no merge progress. It survives
   * head changes; a push by anyone else or `lobstah watch release` resets it.
   */
  repairStreak?: RepairStreak;
}

export interface RepairStreak {
  /** Repairs that finished and still left the PR needing a repair. */
  count: number;
  /** The last repair started; judged once, when the next repair is due. */
  lastRepairId?: string;
  /** The PR head when that repair started. */
  startHead?: string;
  /** Set when repairs stopped at the cap: the head they stopped at. A push by anyone else resets the streak. */
  stoppedHead?: string;
}

/** The failing check runs as one comparable string: names and run URLs. */
function failingKey(pr: PrEvidence): string {
  return (pr.failingChecks ?? [])
    .map((c) => `${c.name}\0${c.detailsUrl ?? ''}`)
    .sort()
    .join('\n');
}

/**
 * When the value last changed. A value equal to the previous observation's
 * keeps the previous time. A record written before the time existed takes
 * the previous observation's time.
 */
function sinceOf(same: boolean, before: string | undefined, previousObservation: string | undefined, now: string): string {
  return same ? (before ?? previousObservation ?? now) : now;
}

/** What the stable PR order reads. */
export interface PrOrderable {
  url: string;
  number: number;
  firstSeenAt?: string;
}

/**
 * The first-seen time a PR without one sorts at: the earliest first-seen
 * time in the set, or '' when no PR in the set has one.
 */
export function prFirstSeenFloor(prs: readonly PrOrderable[]): string {
  let floor = '';
  for (const p of prs) if (p.firstSeenAt && (!floor || p.firstSeenAt < floor)) floor = p.firstSeenAt;
  return floor;
}

/**
 * The PR order every list shares: newest first-seen time first, then the
 * higher number, then the url. A PR without a first-seen time sorts at the
 * set's floor (prFirstSeenFloor), so it orders by number among the oldest.
 * Observation time is never part of the key.
 */
export function prNewestFirst(prs: readonly PrOrderable[]): (a: PrOrderable, b: PrOrderable) => number {
  const floor = prFirstSeenFloor(prs);
  const at = (p: PrOrderable) => p.firstSeenAt || floor;
  return (a, b) => at(b).localeCompare(at(a)) || b.number - a.number || a.url.localeCompare(b.url);
}

export function prsDir(): string {
  return path.join(lobstahHome(), 'prs');
}

/** `pr:<owner>/<repo>#<n>` → `<owner>__<repo>__<n>.json`. */
export function prRecordFile(key: string): string {
  const ref = parsePrRef(key);
  if (!ref) throw new Error(`not a PR key: ${key}`);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(prsDir(), `${safe(ref.owner)}__${safe(ref.repo)}__${ref.number}.json`);
}

export function readPr(key: string): PrRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(prRecordFile(key), 'utf8')) as PrRecord;
  } catch {
    return undefined;
  }
}

export function readPrs(): PrRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(prsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(prsDir(), f), 'utf8')) as PrRecord;
      return typeof r.key === 'string' && typeof r.url === 'string' ? [r] : [];
    } catch {
      return [];
    }
  });
}

/** One process at a time may plan and claim work for a PR. Observations use the same lock. */
export function withPrLock<T>(key: string, action: () => T): T {
  fs.mkdirSync(prsDir(), { recursive: true });
  const lock = `${prRecordFile(key)}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        // A crashed claimant leaves a directory. Its work is reconsidered on the next tick.
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
      } catch {
        /* another process removed it first */
      }
      if (Date.now() >= deadline) throw new Error(`PR record locked: ${key}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.rmdirSync(lock);
  }
}

/**
 * Write one observation. Fields come from the new observation (an absent
 * optional field keeps the previous value; a new title replaces the old one);
 * `dispatchId`, when the observing watch is dispatch-owned, is appended once.
 * Returns the record before and after, so the caller can act on the
 * open → merged/closed transition.
 */
export function upsertPr(pr: PrEvidence, dispatchId?: string): { before?: PrRecord; after: PrRecord } {
  const ref = parsePrRef(pr.url);
  if (!ref) throw new Error(`not a PR url: ${pr.url}`);
  return withPrLock(ref.key, () => {
    const before = readPr(ref.key);
    // A new record is first seen now. A record from before firstSeenAt takes
    // the floor it already sorts at, so its place does not move.
    const firstSeenAt = before?.firstSeenAt ?? (before ? prFirstSeenFloor(readPrs()) || pr.observedAt : pr.observedAt);
    const dispatches = [...(before?.dispatches ?? [])];
    if (dispatchId && !dispatches.includes(dispatchId)) dispatches.push(dispatchId);
    const merged = { ...(before ?? {}), ...pr, failingChecks: pr.failingChecks } as PrEvidence;
    const standingSince: PrRecord['standingSince'] = {};
    for (const kind of prStandingKinds(merged)) {
      standingSince[kind] = before?.standingSince?.[kind] ?? pr.observedAt;
    }
    const after: PrRecord = {
      ...merged,
      key: ref.key,
      repo: `${ref.owner}/${ref.repo}`,
      dispatches,
      standingSince,
      observations: (before?.observations ?? 0) + 1,
      firstSeenAt,
      headSince: sinceOf(before?.headSha === pr.headSha, before?.headSince, before?.observedAt, pr.observedAt),
      baseSince: sinceOf(
        !!before && before.baseRefName === pr.baseRefName && before.baseSha === (pr.baseSha ?? before.baseSha),
        before?.baseSince,
        before?.observedAt,
        pr.observedAt,
      ),
      ...(pr.failingChecks?.length
        ? { failingSince: sinceOf(!!before && failingKey(before) === failingKey(pr), before?.failingSince, before?.observedAt, pr.observedAt) }
        : { failingSince: undefined }),
      repair: before?.headSha === pr.headSha ? before?.repair : undefined,
      // A merged or closed PR ends the run of repairs without progress.
      ...(pr.state === 'OPEN' ? {} : { repairStreak: undefined }),
    };
    writePr(after);
    return { before, after };
  });
}

/**
 * Set a record's title without an observation (`lobstah watch backfill`).
 * Returns false when the record does not exist.
 */
export function setPrTitle(key: string, title: string): boolean {
  return withPrLock(key, () => {
    const record = readPr(key);
    if (!record) return false;
    writePr({ ...record, title });
    return true;
  });
}

/** Persist a watch repair transition without another forge observation. */
export function writePr(pr: PrRecord): void {
  fs.mkdirSync(prsDir(), { recursive: true });
  const file = prRecordFile(pr.key);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(pr, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function removePr(key: string): boolean {
  const file = prRecordFile(key);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

/**
 * A person's release (`lobstah watch release`): the PR's run of repairs
 * without progress starts over, and a stop at the cap is lifted. Returns
 * the PR keys it reset; `key` absent means every PR.
 */
export function resetRepairStreaks(key?: string): string[] {
  const reset: string[] = [];
  for (const pr of key === undefined ? readPrs() : [readPr(key)].filter((p): p is PrRecord => p !== undefined)) {
    if (!pr.repairStreak) continue;
    withPrLock(pr.key, () => {
      const current = readPr(pr.key);
      if (!current?.repairStreak) return;
      const stopped = current.repair?.status === 'gave-up' && current.repairStreak.stoppedHead !== undefined;
      const { repairStreak: _streak, ...rest } = current;
      writePr({ ...rest, ...(stopped ? { repair: undefined } : {}) } as PrRecord);
      reset.push(pr.key);
    });
  }
  return reset;
}
