import type { WatchSnapshot } from '@lobstah/watch-types';
import type { Watch, WatchAttention, WatchEvent } from './watch.js';
import { WatchJournal } from './watch-journal.js';

/** Stored view data is enough to render a type that this process never instantiates. */
export interface JournalWatchView {
  snapshot: WatchSnapshot;
  watch: Watch;
  events: WatchEvent[];
  pending: WatchEvent[];
}

/** Read observations and supplied presentation without invoking a provider. */
export function journalWatchViews(exclude: ReadonlySet<string> = new Set()): JournalWatchView[] {
  return new WatchJournal()
    .list()
    .filter((snapshot) => snapshot.status !== 'retired' && !exclude.has(snapshot.key))
    .map((snapshot) => {
      const pendingIds = new Set(
        snapshot.deliveries.filter((delivery) => delivery.status === 'pending').flatMap((delivery) => delivery.eventIds),
      );
      const events: WatchEvent[] = snapshot.events.map((event) => ({
        seq: event.id,
        summary: event.summary,
        at: event.at,
        kind: event.kind,
        data: event.data,
      }));
      const pending = events.filter((event) => pendingIds.has(String(event.seq)));
      const owner: Watch['owner'] =
        snapshot.owner.kind === 'helm'
          ? 'man'
          : snapshot.owner.kind === 'dispatch'
            ? `dispatch:${snapshot.owner.chainId}`
            : `trap:${snapshot.owner.trapId}`;
      const watch: Watch = {
        key: snapshot.key,
        typeId: snapshot.type.id,
        generation: snapshot.generation,
        ...snapshot.deliveryProgress,
        owner,
        grounds: snapshot.owner.grounds,
        check: '',
        cursor: typeof snapshot.cursor === 'string' ? snapshot.cursor : JSON.stringify(snapshot.cursor),
        createdAt: snapshot.createdAt,
        lastCheckedAt: snapshot.checkedAt,
        seen: events.length - pending.length,
        seenAt: 0,
        presentation: snapshot.presentation,
        ...(snapshot.failure ? { lastError: snapshot.failure.message, remedy: snapshot.failure.remedy } : {}),
        ...(snapshot.status === 'held' ? { heldAt: snapshot.checkedAt ?? snapshot.createdAt, heldReason: snapshot.failure?.message } : {}),
      };
      return { snapshot, watch, events, pending };
    });
}

/** The hook's observation-only path consumes helm or direct trap events by receipt. */
export function pendingJournalWatchEvents(
  exclude: ReadonlySet<string>,
  consume: boolean,
  owner: 'man' | 'dispatch' | `trap:${string}`,
  sinceMs = 0,
): WatchAttention[] {
  const journal = new WatchJournal();
  const result: WatchAttention[] = [];
  for (const view of journalWatchViews(exclude)) {
    if ((owner === 'dispatch' ? !view.watch.owner.startsWith('dispatch:') : view.watch.owner !== owner) || !view.pending.length) continue;
    const events = sinceMs > 0 ? view.pending.filter((event) => Date.parse(event.at) >= sinceMs) : view.pending;
    if (events.length) result.push({ watch: view.watch, events });
    if (consume)
      journal.update(view.watch.key, (current) => {
        if (!current || current.generation !== view.snapshot.generation) return { result: undefined };
        const delivered = new Set(
          view.snapshot.deliveries.filter((delivery) => delivery.status === 'pending').map((delivery) => delivery.id),
        );
        for (const delivery of current.deliveries) if (delivered.has(delivery.id)) delivery.status = 'delivered';
        return { snapshot: current, result: undefined };
      });
  }
  return result;
}
