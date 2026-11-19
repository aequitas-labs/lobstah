import { storeWatchTypeDescriptor } from './watch-type-descriptors.js';
import { randomUUID } from 'node:crypto';
import { WatchRegistry, watchJson, retainWatchConditionTimes } from '@lobstah/watch-types';
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
}

/** Provider-free orchestration: identity, leases, atomic progress and durable delivery. */
export class WatchRuntime {
  constructor(
    readonly registry: WatchRegistry,
    readonly journal = new WatchJournal(),
  ) {}

  /** Idempotent same-owner registration never resets a cursor or steals ownership. */
  register(typeId: string, input: string, options: unknown, owner: WatchOwner): WatchSnapshot {
    validateWatchOwner(owner);
    const adapter = this.registry.get(typeId),
      identified = adapter.identify(input, options);
    if (!identified) throw new Error(`Watch reference is not recognized by ${typeId}`);
    storeWatchTypeDescriptor(adapter.descriptor);
    return this.journal.update(identified.key, (existing) => {
      if (existing && existing.status !== 'retired') {
        if (existing.type.id !== typeId) throw new Error(`Watch key belongs to another type: ${identified.key}`);
        if (!ownerEqual(existing.owner, owner)) throw new Error('Watch ownership requires an explicit transfer');
        const snapshot = adapter.restore(existing);
        snapshot.options = identified.options;
        snapshot.presentation = retainWatchConditionTimes(adapter.present(snapshot), snapshot.presentation, new Date().toISOString());
        return { snapshot, result: snapshot };
      }
      const snapshot: WatchSnapshot = {
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
      snapshot.presentation = retainWatchConditionTimes(adapter.present(snapshot), snapshot.presentation, new Date().toISOString());
      return { snapshot, result: snapshot };
    });
  }

  /** Transfer is explicit and keeps undelivered events with the watched source. */
  transfer(key: string, owner: WatchOwner): WatchSnapshot {
    validateWatchOwner(owner);
    return this.journal.update(key, (snapshot) => {
      if (!snapshot || snapshot.status === 'retired') throw new Error(`Watch not found: ${key}`);
      snapshot.owner = owner;
      snapshot.generation = randomUUID();
      snapshot.lease = undefined;
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

  /** Explicit removal cancels delivery and invalidates outstanding observation leases. */
  retire(key: string): void {
    this.journal.update(key, (snapshot) => {
      if (!snapshot) return { result: undefined };
      snapshot.generation = randomUUID();
      snapshot.status = 'retired';
      snapshot.lease = undefined;
      for (const delivery of snapshot.deliveries) delivery.status = 'delivered';
      return { snapshot, result: undefined };
    });
  }

  private begin(key: string, now: number, everySecs: number, force = false): Execution | undefined {
    return this.journal.update<Execution | undefined>(key, (stored) => {
      if (!stored || stored.status !== 'watching' || (stored.lease && stored.lease.until > now)) return { result: undefined };
      const delay = Math.max(everySecs, stored.failure?.retryAfterSecs ?? 0) * 1000;
      if (!force && stored.checkedAt && Date.parse(stored.checkedAt) + delay > now) return { result: undefined };
      let snapshot: WatchSnapshot, adapter: InstalledWatchType | undefined;
      try {
        adapter = this.registry.get(stored.type.id);
        snapshot = adapter.restore(stored);
      } catch (error) {
        let supplied: WatchFailure | undefined;
        try { supplied = adapter?.failure(error); } catch { /* A broken failure formatter cannot hide the restore error. */ }
        stored.status = 'held';
        stored.failure = {
          ...supplied,
          kind: supplied?.kind ?? 'adapter',
          message: supplied?.message ?? (error instanceof Error ? error.message : String(error)),
          remedy: supplied?.remedy ?? 'Install a compatible watch adapter or restore its supported state version.',
          hold: true,
        };
        return { snapshot: stored, result: undefined };
      }
      const token = randomUUID(),
        previousCheckedAt = snapshot.checkedAt;
      snapshot.checkedAt = new Date(now).toISOString();
      snapshot.lease = { token, until: now + 120_000 };
      return { snapshot, result: { snapshot, adapter, token, now, everySecs, previousCheckedAt } };
    });
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
    return this.journal.update<WatchSnapshot | undefined>(execution.snapshot.key, (snapshot) => {
      if (!this.owns(snapshot, execution)) return { result: snapshot };
      if (batch.deferred) {
        if (batch.events.length || batch.done || JSON.stringify(batch.cursor) !== JSON.stringify(snapshot.cursor))
          throw new Error('A deferred watch batch cannot advance progress');
        snapshot.checkedAt = execution.previousCheckedAt;
        snapshot.lease = undefined;
        return { snapshot, result: snapshot };
      }
      const plan = execution.adapter.reduce(structuredClone(snapshot), structuredClone(batch));
      const known = new Set(snapshot.events.map((event) => event.id));
      const fresh = batch.events.filter((event) => {
        if (known.has(event.id)) return false;
        known.add(event.id);
        return true;
      });
      snapshot.state = plan.state;
      snapshot.cursor = plan.cursor;
      snapshot.events.push(...fresh);
      if (fresh.length) snapshot.deliveries.push({ id: randomUUID(), eventIds: fresh.map((event) => event.id), status: 'pending' });
      snapshot.failure = batch.failure;
      snapshot.failures = batch.failure?.shared ? snapshot.failures : batch.failure ? snapshot.failures + 1 : 0;
      if (plan.done) snapshot.status = 'draining';
      if (batch.failure?.hold) snapshot.status = 'held';
      snapshot.lease = undefined;
      snapshot.presentation = retainWatchConditionTimes(
        execution.adapter.present(structuredClone(snapshot)),
        snapshot.presentation,
        new Date(execution.now).toISOString(),
      );
      return { snapshot, result: snapshot };
    });
  }

  private failed(execution: Execution, error: unknown): WatchSnapshot | undefined {
    return this.journal.update<WatchSnapshot | undefined>(execution.snapshot.key, (snapshot) => {
      if (!this.owns(snapshot, execution)) return { result: snapshot };
      snapshot.failure = execution.adapter.failure(error);
      if (!snapshot.failure.shared) snapshot.failures++;
      snapshot.lease = undefined;
      if (snapshot.failure.hold) snapshot.status = 'held';
      snapshot.presentation = retainWatchConditionTimes(
        execution.adapter.present(structuredClone(snapshot)),
        snapshot.presentation,
        new Date(execution.now).toISOString(),
      );
      return { snapshot, result: snapshot };
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
      if (current.actionReceipts?.some((receipt) => receipt.generation === current.generation && (receipt.status === 'pending' || receipt.status === 'running'))) return { result: undefined };
      current.status = 'closing';
      current.lease = undefined;
      return { snapshot: current, result: current };
    });
    if (!snapshot) return false;
    const adapter = this.registry.get(snapshot.type.id);
    try {
      await adapter.close({ snapshot: structuredClone(snapshot), now: new Date().toISOString() }, reason);
    } catch (error) {
      this.journal.update(key, (current) => {
        if (current?.generation !== snapshot.generation) return { result: undefined };
        current.failure = adapter.failure(error);
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
    this.journal.update(key, (current) => {
      if (!current || current.status !== 'held') return { result: undefined };
      const snapshot = this.registry.get(current.type.id).restore(current);
      snapshot.status = 'watching';
      snapshot.failure = undefined;
      snapshot.checkedAt = undefined;
      return { snapshot, result: undefined };
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
