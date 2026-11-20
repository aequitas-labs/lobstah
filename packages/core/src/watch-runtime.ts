import { storeWatchTypeDescriptor } from './watch-type-descriptors.js';
import { randomUUID } from 'node:crypto';
import { WatchRegistry, watchJson, retainWatchConditionTimes, validateWatchPresentation } from '@lobstah/watch-types';
import type {
  InstalledWatchType,
  WatchCloseReason,
  WatchContext,
  WatchDelivery,
  WatchFailure,
  WatchObservation,
  WatchObservationBatch,
  WatchOwner,
  WatchPresentation,
  WatchSnapshot,
  WatchValue,
} from '@lobstah/watch-types';
import { WatchJournal } from './watch-journal.js';
import { sourceWatchFailure } from './watch-source-errors.js';

const emptyPresentation = (): WatchPresentation => ({
  title: '',
  summary: '',
  label: 'Watch',
  tone: 'neutral',
  worker: { steps: [] },
  helm: { steps: [] },
  rows: [],
  links: [],
  actions: [],
  attention: [],
});
const ownerEqual = (a: WatchOwner, b: WatchOwner): boolean =>
  a.grounds === b.grounds &&
  a.kind === b.kind &&
  (a.kind === 'helm' ||
    (a.kind === 'dispatch' && b.kind === 'dispatch' && a.chainId === b.chainId) ||
    (a.kind === 'trap' && b.kind === 'trap' && a.trapId === b.trapId));
const isPromise = <T>(value: T | Promise<T>): value is Promise<T> => typeof (value as Promise<T> | undefined)?.then === 'function';

type RuntimeContext = WatchContext<WatchValue, WatchValue, WatchValue, WatchValue>;
interface Execution {
  snapshot: WatchSnapshot;
  adapter: InstalledWatchType;
  token: string;
  now: number;
  everySecs: number;
  previousCheckedAt?: string;
  committed?: boolean;
}

/** Fields a source reads while producing its next checkpoint and presentation. */
function sourceRevision(snapshot: WatchSnapshot): string {
  return JSON.stringify([
    snapshot.type,
    snapshot.reference,
    snapshot.options,
    snapshot.state,
    snapshot.cursor,
    snapshot.events,
    snapshot.failure,
  ]);
}

/** Publish source changes without replacing concurrent delivery or action receipts. */
function applySource(target: WatchSnapshot, source: WatchSnapshot): void {
  target.type = source.type;
  target.reference = source.reference;
  target.options = source.options;
  target.state = source.state;
  target.cursor = source.cursor;
  target.presentation = source.presentation;
}

/**
 * Built-in and plugin presentations share one validation path: a version 2
 * presentation is checked like a plugin's before it is cached, so an invalid
 * item or action binding holds its source instead of reaching a renderer.
 */
function presentSource(adapter: Pick<InstalledWatchType, 'present'>, snapshot: WatchSnapshot): WatchPresentation {
  const presentation = adapter.present(snapshot);
  return presentation.version === 2 ? validateWatchPresentation(presentation, 2) : presentation;
}

/** Provider-free orchestration: identity, leases, atomic progress and durable delivery. */
export class WatchRuntime {
  constructor(
    public registry: WatchRegistry,
    readonly journal = new WatchJournal(),
  ) {}

  /** Idempotent same-owner registration never resets a cursor or steals ownership. */
  register(typeId: string, input: string, options: unknown, owner: WatchOwner): WatchSnapshot {
    validateWatchOwner(owner);
    const adapter = this.registry.get(typeId),
      identified = adapter.identify(input, options);
    if (!identified) throw new Error(`Watch reference is not recognized by ${typeId}`);
    storeWatchTypeDescriptor(adapter.descriptor);
    for (let attempt = 0; attempt < 8; attempt++) {
      const prior = this.journal.read(identified.key);
      const active = prior && prior.status !== 'retired' ? prior : undefined;
      if (active?.status === 'closing') throw new Error('Watch cleanup is pending; retry registration after cleanup.');
      if (active?.type.id && active.type.id !== typeId) throw new Error(`Watch key belongs to another type: ${identified.key}`);
      if (active && !ownerEqual(active.owner, owner)) throw new Error('Watch ownership requires an explicit transfer');
      const prepared: WatchSnapshot = active
        ? adapter.restore(structuredClone(active))
        : {
            type: { ...adapter.descriptor },
            ...identified,
            owner,
            generation: randomUUID(),
            status: 'watching',
            events: [],
            deliveries: [],
            presentation: emptyPresentation(),
            createdAt: new Date().toISOString(),
            failures: 0,
          };
      prepared.options = identified.options;
      prepared.presentation = retainWatchConditionTimes(presentSource(adapter, prepared), prepared.presentation, new Date().toISOString());
      const result = this.journal.update<WatchSnapshot | undefined>(identified.key, (current) => {
        if (current?.generation !== prior?.generation || (current && prior && sourceRevision(current) !== sourceRevision(prior)))
          return { result: undefined };
        if (active && current) {
          applySource(current, prepared);
          return { snapshot: current, result: current };
        }
        return { snapshot: prepared, result: prepared };
      });
      if (result) return result;
    }
    throw new Error('Watch registration changed concurrently; retry registration');
  }

  /** Transfer is explicit and keeps undelivered events with the watched source. */
  transfer(key: string, owner: WatchOwner): WatchSnapshot {
    validateWatchOwner(owner);
    return this.journal.update(key, (snapshot) => {
      if (!snapshot || snapshot.status === 'retired') throw new Error(`Watch not found: ${key}`);
      snapshot.owner = owner;
      snapshot.generation = randomUUID();
      snapshot.lease = undefined;
      snapshot.subscriptionLease = undefined;
      return { snapshot, result: snapshot };
    });
  }

  /** Observe async providers with one lease shared by daemon, pickup and inline callers. */
  async check(key: string, options: { now?: number; everySecs?: number } = {}): Promise<WatchSnapshot | undefined> {
    const execution = this.begin(key, options.now ?? Date.now(), options.everySecs ?? 45);
    if (!execution) return this.journal.read(key);
    try {
      return this.complete(execution, await execution.adapter.poll(this.context(execution)));
    } catch (error) {
      return this.failed(execution, error);
    }
  }

  /** A subscribed batch uses the same reducer, dedupe and outbox commit as a poll. */
  accept(key: string, generation: string, batch: WatchObservationBatch<WatchValue>, now = Date.now()): boolean {
    const current = this.journal.read(key);
    if (current?.generation !== generation || current.status !== 'watching') return false;
    const execution = this.begin(key, now, 0, true);
    if (!execution) return false;
    try {
      this.complete(execution, batch);
      return execution.committed === true;
    } catch (error) {
      this.failed(execution, error);
      return false;
    }
  }

  /** Stream failures retain the committed cursor and only hold their own source. */
  subscriptionFailed(key: string, generation: string, error: unknown): void {
    const observed = this.journal.read(key);
    if (observed?.generation !== generation || observed.status !== 'watching') return;
    let adapter: InstalledWatchType | undefined;
    try {
      adapter = this.registry.get(observed.type.id);
    } catch {
      /* Missing adapters are diagnosed by the same failure path. */
    }
    const failure = sourceWatchFailure(adapter, error);
    this.journal.update(key, (current) => {
      if (current?.generation !== generation || current.status !== 'watching') return { result: undefined };
      current.failure = failure;
      if (!failure.shared) current.failures++;
      if (failure.hold) {
        current.status = 'held';
        current.lease = undefined;
      }
      return { snapshot: current, result: undefined };
    });
  }

  /** The legacy synchronous command API uses the same persistence and lease rules. */
  checkSync(key: string, options: { now?: number; everySecs?: number } = {}): WatchSnapshot | undefined {
    const execution = this.begin(key, options.now ?? Date.now(), options.everySecs ?? 45);
    if (!execution) return this.journal.read(key);
    try {
      const result = execution.adapter.poll(this.context(execution));
      if (isPromise(result)) {
        void result.catch(() => {});
        throw new Error('An asynchronous watch requires the asynchronous runtime');
      }
      return this.complete(execution, result);
    } catch (error) {
      return this.failed(execution, error);
    }
  }

  /** Group due work by adapter capability; a source failure cannot skip its peers. */
  checkManySync(
    keys: readonly string[],
    options: { now?: number; everySecs?: number; force?: boolean } = {},
  ): Map<string, WatchSnapshot | undefined> {
    const now = options.now ?? Date.now(),
      everySecs = options.everySecs ?? 45;
    const result = new Map<string, WatchSnapshot | undefined>(),
      groups = new Map<string, Execution[]>();
    for (const key of new Set(keys)) {
      const execution = this.begin(key, now, everySecs, options.force);
      if (!execution) {
        result.set(key, this.journal.read(key));
        continue;
      }
      try {
        const group = `${execution.adapter.descriptor.id}:${execution.adapter.batchObserver?.group(this.context(execution)) ?? execution.token}`;
        const peers = groups.get(group) ?? [];
        peers.push(execution);
        groups.set(group, peers);
      } catch (error) {
        result.set(key, this.failed(execution, error));
      }
    }
    for (const executions of groups.values()) {
      const first = executions[0]!;
      let batches: Record<string, WatchObservationBatch<WatchValue> | WatchFailure>;
      try {
        const polled = first.adapter.batchObserver
          ? first.adapter.batchObserver.pollBatch(executions.map((execution) => this.context(execution)))
          : { [first.snapshot.key]: first.adapter.poll(this.context(first)) };
        if (isPromise(polled)) {
          void polled.catch(() => {});
          throw new Error('An asynchronous watch requires the asynchronous runtime');
        }
        const asynchronous = Object.values(polled).filter(isPromise);
        for (const pending of asynchronous) void pending.catch(() => {});
        if (asynchronous.length) throw new Error('An asynchronous watch requires the asynchronous runtime');
        batches = polled as Record<string, WatchObservationBatch<WatchValue> | WatchFailure>;
      } catch (error) {
        for (const execution of executions) result.set(execution.snapshot.key, this.failed(execution, error));
        continue;
      }
      for (const execution of executions) {
        try {
          const batch = batches[execution.snapshot.key];
          if (!batch) throw new Error(`Watch batch omitted ${execution.snapshot.key}`);
          result.set(
            execution.snapshot.key,
            this.complete(execution, 'events' in batch ? batch : { cursor: execution.snapshot.cursor, events: [], failure: batch }),
          );
        } catch (error) {
          result.set(execution.snapshot.key, this.failed(execution, error));
        }
      }
    }
    return result;
  }

  private context(execution: Execution): RuntimeContext {
    return { snapshot: structuredClone(execution.snapshot), now: new Date(execution.now).toISOString(), everySecs: execution.everySecs };
  }

  /** Explicit removal fences observation and releases the source outside journal locks. */
  retire(key: string): void {
    const snapshot = this.journal.update<WatchSnapshot | undefined>(key, (current) => {
      if (!current || current.status === 'retired') return { result: undefined };
      current.status = 'closing';
      current.closeReason = 'removed';
      current.lease = undefined;
      current.subscriptionLease = undefined;
      for (const delivery of current.deliveries) delivery.status = 'delivered';
      return { snapshot: current, result: structuredClone(current) };
    });
    if (!snapshot) return;
    let source: InstalledWatchType | undefined;
    const finish = (failure?: WatchFailure): void => {
      this.journal.update(key, (current) => {
        if (!current || current.generation !== snapshot.generation || current.status !== 'closing') return { result: undefined };
        current.status = failure ? 'closing' : 'retired';
        current.failure = failure;
        return { snapshot: current, result: undefined };
      });
    };
    try {
      source = this.registry.get(snapshot.type.id);
      const closed = source.close({ snapshot, now: new Date().toISOString() }, 'removed');
      if (isPromise(closed)) void closed.then(() => finish(), (error) => finish(sourceWatchFailure(source, error)));
      else finish();
    } catch (error) { finish(sourceWatchFailure(source, error)); }
  }

  private begin(key: string, now: number, everySecs: number, force = false): Execution | undefined {
    const claimed = this.journal.update<{ snapshot: WatchSnapshot; token: string; previousCheckedAt?: string } | undefined>(
      key,
      (stored) => {
        if (!stored || stored.status !== 'watching' || (stored.lease && stored.lease.until > now)) return { result: undefined };
        const delay = Math.max(everySecs, stored.failure?.retryAfterSecs ?? 0) * 1000;
        if (!force && stored.checkedAt && Date.parse(stored.checkedAt) + delay > now) return { result: undefined };
        const token = randomUUID(),
          previousCheckedAt = stored.checkedAt;
        stored.checkedAt = new Date(now).toISOString();
        stored.lease = { token, until: now + 120_000 };
        return { snapshot: stored, result: { snapshot: structuredClone(stored), token, previousCheckedAt } };
      },
    );
    if (!claimed) return undefined;
    let adapter: InstalledWatchType | undefined;
    try {
      adapter = this.registry.get(claimed.snapshot.type.id);
      const restored = adapter.restore(structuredClone(claimed.snapshot));
      const source = adapter;
      return this.journal.update<Execution | undefined>(key, (current) => {
        if (current?.generation !== claimed.snapshot.generation || current.lease?.token !== claimed.token || current.status !== 'watching')
          return { result: undefined };
        if (sourceRevision(current) !== sourceRevision(claimed.snapshot)) {
          current.lease = undefined;
          current.checkedAt = claimed.previousCheckedAt;
          return { snapshot: current, result: undefined };
        }
        applySource(current, restored);
        return { snapshot: current, result: { ...claimed, snapshot: structuredClone(current), adapter: source, now, everySecs } };
      });
    } catch (error) {
      const failure = { ...sourceWatchFailure(adapter, error), hold: true };
      this.journal.update(key, (current) => {
        if (current?.generation !== claimed.snapshot.generation || current.lease?.token !== claimed.token) return { result: undefined };
        current.status = 'held';
        current.failure = failure;
        current.lease = undefined;
        return { snapshot: current, result: undefined };
      });
      return undefined;
    }
  }

  private owns(snapshot: WatchSnapshot | undefined, execution: Execution): snapshot is WatchSnapshot {
    return (
      snapshot?.generation === execution.snapshot.generation && snapshot.lease?.token === execution.token && snapshot.status === 'watching'
    );
  }

  private complete(execution: Execution, batch: WatchObservationBatch<WatchValue>): WatchSnapshot | undefined {
    // Validate the entire batch before publishing even its first event or cursor.
    watchJson(batch);
    for (const event of batch.events) {
      if (
        !event.id ||
        typeof event.id !== 'string' ||
        typeof event.kind !== 'string' ||
        typeof event.summary !== 'string' ||
        !Number.isFinite(Date.parse(event.at))
      )
        throw new Error('Invalid normalized watch event');
    }
    const observed = this.journal.read(execution.snapshot.key);
    if (!this.owns(observed, execution)) return observed;
    if (batch.deferred) {
      if (batch.events.length || batch.done || JSON.stringify(batch.cursor) !== JSON.stringify(observed.cursor))
        throw new Error('A deferred watch batch cannot advance progress');
      return this.journal.update<WatchSnapshot | undefined>(observed.key, (current) => {
        if (!this.owns(current, execution)) return { result: current };
        current.checkedAt = execution.previousCheckedAt;
        current.lease = undefined;
        return { snapshot: current, result: current };
      });
    }
    const prepared = structuredClone(observed);
    const plan = execution.adapter.reduce(structuredClone(observed), structuredClone(batch));
    const known = new Set(prepared.events.map((event) => event.id));
    const fresh = batch.events.filter((event) => {
      if (known.has(event.id)) return false;
      known.add(event.id);
      return true;
    });
    prepared.state = plan.state;
    prepared.cursor = plan.cursor;
    prepared.events.push(...fresh);
    prepared.failure = batch.failure;
    prepared.failures = batch.failure?.shared ? prepared.failures : batch.failure ? prepared.failures + 1 : 0;
    if (plan.done) prepared.status = 'draining';
    if (batch.failure?.hold) prepared.status = 'held';
    prepared.lease = undefined;
    prepared.presentation = retainWatchConditionTimes(
      presentSource(execution.adapter, structuredClone(prepared)),
      observed.presentation,
      new Date(execution.now).toISOString(),
    );
    return this.journal.update<WatchSnapshot | undefined>(observed.key, (current) => {
      if (!this.owns(current, execution)) return { result: current };
      if (sourceRevision(current) !== sourceRevision(observed)) {
        current.lease = undefined;
        current.checkedAt = execution.previousCheckedAt;
        return { snapshot: current, result: current };
      }
      applySource(current, prepared);
      execution.committed = true;
      current.events.push(...fresh);
      if (fresh.length) current.deliveries.push({ id: randomUUID(), eventIds: fresh.map((event) => event.id), status: 'pending' });
      current.failure = prepared.failure;
      current.failures = prepared.failures;
      current.status = prepared.status;
      current.lease = undefined;
      return { snapshot: current, result: current };
    });
  }

  private failed(execution: Execution, error: unknown): WatchSnapshot | undefined {
    const failure = sourceWatchFailure(execution.adapter, error);
    const observed = this.journal.read(execution.snapshot.key);
    if (!this.owns(observed, execution)) return observed;
    const prepared = structuredClone(observed);
    prepared.failure = failure;
    if (!failure.shared) prepared.failures++;
    prepared.lease = undefined;
    if (failure.hold) prepared.status = 'held';
    try {
      prepared.presentation = retainWatchConditionTimes(
        presentSource(execution.adapter, prepared),
        observed.presentation,
        new Date(execution.now).toISOString(),
      );
    } catch {
      /* Retain the last valid presentation when the source process is unavailable. */
    }
    return this.journal.update<WatchSnapshot | undefined>(observed.key, (current) => {
      if (!this.owns(current, execution)) return { result: current };
      current.failure = failure;
      current.failures = prepared.failures;
      current.status = prepared.status;
      current.lease = undefined;
      if (sourceRevision(current) === sourceRevision(prepared)) current.presentation = prepared.presentation;
      return { snapshot: current, result: current };
    });
  }

  /** Outbox replay returns the same continuation ID after a crash at any delivery step. */
  claimDelivery(key: string, deliveryId: string): WatchDelivery {
    return this.journal.update(key, (snapshot) => {
      const delivery = snapshot?.deliveries.find((entry) => entry.id === deliveryId);
      if (!snapshot || !delivery) throw new Error('Watch delivery not found');
      delivery.continuationId ??= randomUUID();
      return { snapshot, result: structuredClone(delivery) };
    });
  }

  /** A receipt is durable independently of whether the source has reached done. */
  acknowledge(key: string, deliveryId: string): void {
    this.journal.update(key, (snapshot) => {
      const delivery = snapshot?.deliveries.find((entry) => entry.id === deliveryId);
      if (!snapshot || !delivery) throw new Error('Watch delivery not found');
      delivery.status = 'delivered';
      return { snapshot, result: undefined };
    });
  }

  /** Finish only after the terminal tail is delivered; failed cleanup is retryable. */
  async close(key: string, reason: WatchCloseReason = 'done'): Promise<boolean> {
    const snapshot = this.journal.update(key, (current) => {
      if (!current || current.status === 'retired') return { result: undefined };
      if (reason === 'done' && current.status !== 'draining' && current.status !== 'closing') return { result: undefined };
      if (current.deliveries.some((delivery) => delivery.status === 'pending')) return { result: undefined };
      if (
        current.actionReceipts?.some(
          (receipt) => receipt.generation === current.generation && (receipt.status === 'pending' || receipt.status === 'running'),
        )
      )
        return { result: undefined };
      current.status = 'closing';
      current.lease = undefined;
      return { snapshot: current, result: current };
    });
    if (!snapshot) return false;
    let adapter: InstalledWatchType | undefined;
    try {
      adapter = this.registry.get(snapshot.type.id);
      await adapter.close({ snapshot: structuredClone(snapshot), now: new Date().toISOString() }, snapshot.closeReason ?? reason);
    } catch (error) {
      const failure = sourceWatchFailure(adapter, error);
      this.journal.update(key, (current) => {
        if (current?.generation !== snapshot.generation) return { result: undefined };
        current.failure = failure;
        return { snapshot: current, result: undefined };
      });
      return false;
    }
    return this.journal.update(key, (current) => {
      if (current?.generation !== snapshot.generation) return { result: false };
      current.status = 'retired';
      current.failure = undefined;
      return { snapshot: current, result: true };
    });
  }

  /** Resume a held type only after its adapter can restore the stored state. */
  release(key: string): void {
    const observed = this.journal.read(key);
    if (!observed || observed.status !== 'held') return;
    const restored = this.registry.get(observed.type.id).restore(structuredClone(observed));
    this.journal.update(key, (current) => {
      if (
        !current ||
        current.generation !== observed.generation ||
        current.status !== 'held' ||
        sourceRevision(current) !== sourceRevision(observed)
      )
        return { result: undefined };
      applySource(current, restored);
      current.status = 'watching';
      current.failure = undefined;
      current.checkedAt = undefined;
      return { snapshot: current, result: undefined };
    });
  }
}

/** Malformed or ephemeral owner identities never enter the durable journal. */
export function validateWatchOwner(owner: WatchOwner): void {
  if (!owner.grounds || !['helm', 'dispatch', 'trap'].includes(owner.kind))
    throw new Error('A durable watch owner and grounds are required');
  if (owner.kind === 'dispatch' && !owner.chainId) throw new Error('A watch dispatch chain is required');
  if (owner.kind === 'trap' && !owner.trapId) throw new Error('A stable watch trap ID is required');
}

/** Read only the events referenced by an outbox receipt, in their recorded order. */
export function watchDeliveryEvents(snapshot: WatchSnapshot, delivery: WatchDelivery): WatchObservation[] {
  const ids = new Set(delivery.eventIds);
  return snapshot.events.filter((event) => ids.has(event.id));
}
