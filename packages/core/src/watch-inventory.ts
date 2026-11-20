import type { WatchGlyph, WatchSnapshot, WatchSourceBrand } from '@lobstah/watch-types';
import { presentationView } from '@lobstah/watch-types/presentation-view';
import { WatchJournal } from './watch-journal.js';
import { listWatches, watchIntervalSecs } from './watch.js';
import type { Watch } from './watch.js';

/**
 * The Watches inventory: every non-retired durable watch, with the
 * scheduler's own view of when it was last attempted, when it last
 * succeeded, when it is next eligible and how healthy it is. The page
 * renders these values; it does no schedule arithmetic of its own. Reading
 * the inventory starts no plugin and reads no provider.
 */

/** When a watch is next eligible to check, as an estimate the scheduler can meet. */
export type WatchNextCheck =
  | { state: 'due' }
  | { state: 'scheduled'; at: string }
  | { state: 'checking' }
  | { state: 'held' }
  | { state: 'draining' }
  | { state: 'closing' }
  | { state: 'offline' }
  | { state: 'unknown' };

/** Health in words as well as color: provider-wide outages are the source's; a watch's own error stays on the watch. */
export type WatchHealthState = 'healthy' | 'not-checked' | 'checking' | 'retrying' | 'held' | 'stale' | 'offline';

export interface WatchInventoryRow {
  key: string;
  generation: string;
  type: string;
  /** The source version that last presented it, when known. */
  version?: string;
  status: WatchSnapshot['status'];
  owner: { kind: 'helm' | 'dispatch' | 'trap'; id: string; grounds: string; name?: string };
  source: WatchSourceBrand;
  title: string;
  subtitle: string;
  glyph?: WatchGlyph;
  /** A source's derived view of local records, listed apart so it does not read as another running watch. */
  derived: boolean;
  createdAt: string;
  /** The last check attempt; absent when it was never attempted. */
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  next: WatchNextCheck;
  health: WatchHealthState;
  /** Delivery is held while observation continues: the watch still polls. */
  deliveryHeld?: { since: string; reason?: string };
  error?: { message: string; remedy?: string; failures: number };
  /** Validated links, the first of which is the card's Open. */
  links: Array<{ label: string; url: string }>;
  /** On a hosted glass with several boats: the boat that has this watch. */
  boat?: string;
}

export interface WatchInventoryOptions {
  now?: number;
  /** The scheduler's cadence for watches without their own. */
  everySecs: number;
  /** The daemon's last heartbeat; a missing or old one means nothing checks. */
  daemonHeartbeat?: string;
  /** How old a heartbeat may be before the daemon counts as offline. */
  offlineAfterMs?: number;
  /** Owner display names, resolved by the host; the ID stays the fallback. */
  ownerName?: (owner: WatchInventoryRow['owner']) => string | undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The native runtime's rule: the larger of the cadence and a failure's retry-after, from the last attempt. */
function nativeDelaySecs(snapshot: WatchSnapshot, everySecs: number): number {
  return Math.max(everySecs, snapshot.failure?.retryAfterSecs ?? 0);
}

function ownerOf(snapshot: Pick<WatchSnapshot, 'owner'>): WatchInventoryRow['owner'] {
  const owner = snapshot.owner;
  if (owner.kind === 'dispatch') return { kind: 'dispatch', id: owner.chainId, grounds: owner.grounds };
  if (owner.kind === 'trap') return { kind: 'trap', id: owner.trapId, grounds: owner.grounds };
  return { kind: 'helm', id: owner.grounds, grounds: owner.grounds };
}

function legacyOwner(watch: Watch): WatchInventoryRow['owner'] {
  const grounds = watch.grounds ?? 'home';
  if (watch.owner.startsWith('dispatch:')) return { kind: 'dispatch', id: watch.owner.slice('dispatch:'.length), grounds };
  if (watch.owner.startsWith('trap:')) return { kind: 'trap', id: watch.owner.slice('trap:'.length), grounds };
  return { kind: 'helm', id: grounds, grounds };
}

/** Next eligibility and health from the stored schedule facts, never from the page. */
function schedule(
  facts: {
    status: WatchSnapshot['status'];
    lastAttemptAt?: string;
    leaseUntil?: number;
    delayMs: number;
    failure?: { message: string; remedy?: string; shared?: boolean; retryAfterSecs?: number };
    failures: number;
    derived: boolean;
  },
  now: number,
  offline: boolean,
): { next: WatchNextCheck; health: WatchHealthState } {
  if (facts.status === 'held') return { next: { state: 'held' }, health: 'held' };
  if (facts.status === 'draining') return { next: { state: 'draining' }, health: facts.failure ? 'retrying' : 'healthy' };
  if (facts.status === 'closing') return { next: { state: 'closing' }, health: facts.failure ? 'retrying' : 'healthy' };
  if (facts.leaseUntil !== undefined && facts.leaseUntil > now) return { next: { state: 'checking' }, health: 'checking' };
  if (offline) return { next: { state: 'offline' }, health: 'offline' };
  if (facts.derived && !facts.lastAttemptAt) return { next: { state: 'unknown' }, health: 'healthy' };
  const health: WatchHealthState = facts.failure?.shared ? 'stale' : facts.failure ? 'retrying' : facts.lastAttemptAt ? 'healthy' : 'not-checked';
  if (!facts.lastAttemptAt) return { next: { state: 'due' }, health };
  const at = Date.parse(facts.lastAttemptAt) + facts.delayMs;
  if (!Number.isFinite(at)) return { next: { state: 'unknown' }, health };
  return { next: at <= now ? { state: 'due' } : { state: 'scheduled', at: iso(at) }, health };
}

/** Every non-retired durable watch, from the journal and from legacy records not yet imported. */
export function watchInventory(options: WatchInventoryOptions, journal = new WatchJournal(), legacy: readonly Watch[] = listWatches()): WatchInventoryRow[] {
  const now = options.now ?? Date.now();
  const heartbeat = options.daemonHeartbeat ? Date.parse(options.daemonHeartbeat) : NaN;
  const offline = !Number.isFinite(heartbeat) || now - heartbeat > (options.offlineAfterMs ?? 5 * 60_000);
  const legacyByKey = new Map(legacy.map((watch) => [watch.key, watch]));
  const rows: WatchInventoryRow[] = [];
  const seen = new Set<string>();
  for (const snapshot of journal.list()) {
    if (snapshot.status === 'retired') continue;
    seen.add(snapshot.key);
    const view = presentationView(snapshot.presentation, snapshot.type.id);
    const derived = snapshot.presentation.listing === 'conditions';
    const record = legacyByKey.get(snapshot.key);
    // A legacy record keeps its own scheduler: its backoff runs from its own last check.
    const lastAttemptAt = record?.lastCheckedAt ?? snapshot.checkedAt;
    const delayMs = (record ? watchIntervalSecs(record, options.everySecs) : nativeDelaySecs(snapshot, options.everySecs)) * 1000;
    const progress = snapshot.deliveryProgress;
    const owner = ownerOf(snapshot);
    const timing = schedule(
      { status: snapshot.status, lastAttemptAt, leaseUntil: snapshot.lease?.until, delayMs, failure: snapshot.failure, failures: snapshot.failures, derived },
      now,
      offline,
    );
    rows.push({
      key: snapshot.key,
      generation: snapshot.generation,
      type: snapshot.type.id,
      version: snapshot.type.version,
      status: snapshot.status,
      owner: { ...owner, ...(options.ownerName?.(owner) ? { name: options.ownerName(owner) } : {}) },
      source: view.source,
      title: view.title || snapshot.key,
      subtitle: view.subtitle,
      ...(snapshot.presentation.glyph ? { glyph: snapshot.presentation.glyph } : {}),
      derived,
      createdAt: snapshot.createdAt,
      ...(lastAttemptAt ? { lastAttemptAt } : {}),
      ...(snapshot.lastSuccessAt ? { lastSuccessAt: snapshot.lastSuccessAt } : {}),
      ...timing,
      ...(progress?.heldAt && snapshot.status === 'watching' ? { deliveryHeld: { since: progress.heldAt, ...(progress.heldReason ? { reason: progress.heldReason } : {}) } } : {}),
      ...(snapshot.failure
        ? { error: { message: snapshot.failure.message, ...(snapshot.failure.remedy ? { remedy: snapshot.failure.remedy } : {}), failures: snapshot.failures } }
        : {}),
      links: view.links,
    });
  }
  for (const watch of legacy) {
    if (seen.has(watch.key) || watch.done) continue;
    const view = presentationView(watch.presentation, watch.typeId ?? 'command');
    const owner = legacyOwner(watch);
    const timing = schedule(
      {
        status: 'watching',
        lastAttemptAt: watch.lastCheckedAt,
        delayMs: watchIntervalSecs(watch, options.everySecs) * 1000,
        ...(watch.lastError ? { failure: { message: watch.lastError, remedy: watch.remedy } } : {}),
        failures: watch.failures ?? 0,
        derived: false,
      },
      now,
      offline,
    );
    rows.push({
      key: watch.key,
      generation: watch.generation ?? watch.createdAt,
      type: watch.typeId ?? 'command',
      status: 'watching',
      owner: { ...owner, ...(options.ownerName?.(owner) ? { name: options.ownerName(owner) } : {}) },
      source: view.source,
      title: watch.presentation?.title || watch.key,
      subtitle: view.subtitle,
      derived: false,
      createdAt: watch.createdAt,
      ...(watch.lastCheckedAt ? { lastAttemptAt: watch.lastCheckedAt } : {}),
      ...timing,
      ...(watch.heldAt ? { deliveryHeld: { since: watch.heldAt, ...(watch.heldReason ? { reason: watch.heldReason } : {}) } } : {}),
      ...(watch.lastError ? { error: { message: watch.lastError, ...(watch.remedy ? { remedy: watch.remedy } : {}), failures: watch.failures ?? 0 } } : {}),
      links: view.links,
    });
  }
  return rows.sort(watchTimestampOrder);
}

/**
 * Timestamp order: the latest check attempt first; a watch never checked
 * sorts by its creation time; the watch ID breaks ties. Source mode keeps
 * the same order inside each group.
 */
export function watchTimestampOrder(a: Pick<WatchInventoryRow, 'lastAttemptAt' | 'createdAt' | 'key'>, b: Pick<WatchInventoryRow, 'lastAttemptAt' | 'createdAt' | 'key'>): number {
  return (b.lastAttemptAt ?? b.createdAt).localeCompare(a.lastAttemptAt ?? a.createdAt) || a.key.localeCompare(b.key);
}
