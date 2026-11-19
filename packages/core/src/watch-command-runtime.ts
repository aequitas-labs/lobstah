import { randomUUID } from 'node:crypto';
import { readWatch, readWatchEvents } from './watch.js';
import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { WatchOwner, WatchSnapshot } from '@lobstah/watch-types';
import { WatchRuntime } from './watch-runtime.js';
import type { Watch, WatchEvent } from './watch.js';

/** The legacy CLI and typed runtime share the shipped command adapter. */
export function commandWatchRuntime(): WatchRuntime {
  const registry = new WatchRegistry();
  registry.register(new CommandWatchType());
  return new WatchRuntime(registry);
}

/** Import a legacy key without resetting progress or leaking a session identity. */
export function commandWatchOwner(watch: Watch): WatchOwner {
  const grounds = watch.grounds ?? 'home';
  if (watch.owner.startsWith('dispatch:')) return { kind: 'dispatch', chainId: watch.owner.slice(9), grounds };
  if (watch.owner.startsWith('trap:')) return { kind: 'trap', trapId: watch.owner.slice(5), grounds };
  return { kind: 'helm', grounds };
}

/** Re-registration updates command options while preserving all journal receipts. */
export function restoreCommandWatch(watch: Watch): WatchRuntime {
  const runtime = commandWatchRuntime();
  const previous = runtime.journal.read(watch.key);
  const origin = watch.generation ?? watch.createdAt;
  if (previous?.originGeneration && previous.originGeneration !== origin) runtime.retire(watch.key);
  runtime.register(
    'command',
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
  if (!snapshot || snapshot.type.id !== 'command') return;
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
