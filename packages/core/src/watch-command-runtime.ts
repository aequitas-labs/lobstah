import { randomUUID } from 'node:crypto';
import { readWatch, readWatchEvents } from './watch.js';
import { builtinWatchRegistry, watchSourceType } from './watch-source-registry.js';
import type { WatchOwner, WatchSnapshot } from '@lobstah/watch-types';
import { WatchRuntime } from './watch-runtime.js';
import type { Watch, WatchEvent } from './watch.js';

/** Legacy CLI registrations use the same installed source registry as typed watches. */
export function commandWatchRuntime(): WatchRuntime {
  return new WatchRuntime(builtinWatchRegistry());
}

/** Import a legacy key without resetting progress or leaking a session identity. */
export function commandWatchOwner(watch: Watch): WatchOwner {
  const grounds = watch.grounds ?? 'home';
  if (watch.owner.startsWith('dispatch:')) return { kind: 'dispatch', chainId: watch.owner.slice(9), grounds };
  if (watch.owner.startsWith('trap:')) return { kind: 'trap', trapId: watch.owner.slice(5), grounds };
  return { kind: 'helm', grounds };
}

/** Re-registration updates source options while preserving all journal receipts. */
export function restoreCommandWatch(watch: Watch, runtime = commandWatchRuntime()): WatchRuntime {
  const previous = runtime.journal.read(watch.key);
  const origin = watch.generation ?? watch.createdAt;
  const replaced = previous?.originGeneration !== undefined && previous.originGeneration !== origin;
  if (replaced) runtime.retire(watch.key);
  const typeId = watchSourceType(watch, runtime.registry),
    source = runtime.registry.get(typeId);
  const options = { check: watch.check, cursor: watch.cursor, ...(watch.brief ? { brief: watch.brief } : {}) };
  if (!replaced && previous && previous.status !== 'retired' && previous.type.id !== typeId) {
    const binding = source.bindings.find(
      (entry) =>
        entry.event === 'legacy-command' &&
        entry.importsType === previous.type.id &&
        entry.pattern &&
        new RegExp(entry.pattern).test(watch.check),
    );
    if (!binding) throw new Error(`Watch type transfer requires an explicit import: ${previous.type.id} to ${typeId}`);
    const identified = source.identify(watch.key, options);
    if (!identified) throw new Error('Watch source rejected its legacy reference');
    runtime.journal.update(watch.key, (snapshot) => {
      if (!snapshot || snapshot.generation !== previous.generation) throw new Error('Watch changed during source import');
      // The source validates the previous checkpoint; deliveries and their reserved IDs stay intact.
      const imported = source.restore({
        ...snapshot,
        type: source.descriptor,
        reference: identified.reference,
        state: identified.state,
        options: identified.options,
      });
      return { snapshot: imported, result: undefined };
    });
  }
  runtime.register(
    typeId,
    watch.key,
    { check: watch.check, cursor: watch.cursor, ...(watch.brief ? { brief: watch.brief } : {}) },
    commandWatchOwner(watch),
  );
  const legacyEvents = readWatchEvents(watch.key);
  runtime.journal.update(watch.key, (snapshot) => {
    if (!snapshot) throw new Error('Command watch registration disappeared');
    snapshot.originGeneration = origin;
    const known = new Set(snapshot.events.map((event) => event.id));
    const imported = legacyEvents.filter((event) => !known.has(String(event.seq)));
    for (const event of imported) {
      const { summary, at, ...data } = event;
      snapshot.events.push({
        id: String(event.seq),
        kind: typeof event.kind === 'string' ? event.kind : 'event',
        at,
        summary: summary ?? '',
        data: JSON.parse(JSON.stringify(data)),
      });
    }
    const unseen = new Set(legacyEvents.slice(watch.seen).map((event) => String(event.seq)));
    const pending = imported.filter((event) => unseen.has(String(event.seq)));
    if (pending.length)
      snapshot.deliveries.push({ id: randomUUID(), eventIds: pending.map((event) => String(event.seq)), status: 'pending' });
    return { snapshot, result: undefined };
  });
  return runtime;
}

/** Compatibility consumers receive their existing event shape from normalized data. */
export function commandWatchEvents(snapshot: WatchSnapshot): WatchEvent[] {
  return snapshot.events.map((event) => ({
    ...(event.data as Record<string, unknown>),
    seq: ((event.data as Record<string, unknown>).seq as string | number) ?? event.id,
    summary: event.summary || undefined,
    at: event.at,
  }));
}

/** Mark only receipts wholly covered by the consumed compatibility event prefix. */
export function acknowledgeCommandWatch(key: string, events: WatchEvent[], seen: number): void {
  const runtime = commandWatchRuntime(),
    snapshot = runtime.journal.read(key);
  if (!snapshot) return;
  const consumed = new Set(events.slice(0, seen).map((event) => String(event.seq)));
  for (const delivery of snapshot.deliveries)
    if (delivery.status === 'pending' && delivery.eventIds.every((id) => consumed.has(id))) runtime.acknowledge(key, delivery.id);
}

/** A continuation acknowledges only the event prefix included in its original brief. */
export interface CommandWatchContinuation {
  id: string;
  deliveredThrough: number;
}

/** Reserve a complete batch atomically; replay never consumes later arrivals. */
export function claimCommandWatchContinuation(key: string, events?: readonly WatchEvent[]): CommandWatchContinuation | undefined {
  const watch = readWatch(key);
  if (!watch) return undefined;
  const runtime = restoreCommandWatch(watch);
  const recorded = readWatchEvents(key);
  const requested = new Set((events ?? recorded.slice(watch.seen)).map((event) => String(event.seq)));
  const through = recorded.reduce((end, event, index) => (requested.has(String(event.seq)) ? index + 1 : end), watch.seen);
  const prefix = new Set(recorded.slice(0, through).map((event) => String(event.seq)));
  const reservation = runtime.journal.update(key, (snapshot) => {
    if (!snapshot) return { result: undefined };
    const pending = snapshot.deliveries.filter((delivery) => delivery.status === 'pending');
    const existing = pending.find((delivery) => delivery.continuationId !== undefined);
    let id = existing?.continuationId;
    if (!id) {
      const eligible = pending.filter((delivery) => delivery.eventIds.some((eventId) => prefix.has(eventId)));
      if (!eligible.length) return { result: undefined };
      id = randomUUID();
      for (const delivery of eligible) {
        const later = delivery.eventIds.filter((eventId) => !prefix.has(eventId));
        if (later.length) snapshot.deliveries.push({ id: randomUUID(), eventIds: later, status: 'pending' });
        delivery.eventIds = delivery.eventIds.filter((eventId) => prefix.has(eventId));
        delivery.continuationId = id;
      }
    }
    const ids = snapshot.deliveries.filter((delivery) => delivery.continuationId === id).flatMap((delivery) => delivery.eventIds);
    return { snapshot, result: { id, ids } };
  });
  if (!reservation) return undefined;
  const ids = new Set(reservation.ids);
  return {
    id: reservation.id,
    deliveredThrough: recorded.reduce((end, event, index) => (ids.has(String(event.seq)) ? index + 1 : end), watch.seen),
  };
}
