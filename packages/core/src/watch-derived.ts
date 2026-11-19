import type { WatchRegistry } from '@lobstah/watch-types';
import { builtinWatchRegistry } from './watch-source-registry.js';
import { journalWatchViews } from './watch-presentation.js';
import type { JournalWatchView } from './watch-presentation.js';

/** Read-only projection uses source views without registering watches or querying providers. */
export function presentedWatchViews(
  now = Date.now(),
  exclude: ReadonlySet<string> = new Set(),
  registry: WatchRegistry = builtinWatchRegistry(),
): JournalWatchView[] {
  const derived = registry.list().filter((source) => source.derived),
    types = new Set(derived.map((source) => source.descriptor.id));
  const journal = journalWatchViews(exclude),
    prior = new Map(journal.map((view) => [view.snapshot.key, view]));
  const stored = journal.filter((view) => !types.has(view.snapshot.type.id));
  for (const source of derived)
    for (const view of source.derived!.views(new Date(now).toISOString())) {
      if (exclude.has(view.key)) continue;
      const previous = prior.get(view.key);
      if (previous) {
        stored.push({
          ...previous,
          snapshot: { ...previous.snapshot, presentation: view.presentation },
          watch: { ...previous.watch, presentation: view.presentation },
        });
        prior.delete(view.key);
        continue;
      }
      const snapshot = {
        key: view.key,
        type: source.descriptor,
        reference: null,
        state: null,
        cursor: view.revision,
        options: view.options,
        owner: view.owner,
        generation: 'derived',
        status: 'watching' as const,
        events: [],
        deliveries: [],
        presentation: view.presentation,
        createdAt: view.since,
        failures: 0,
      };
      const owner =
        view.owner.kind === 'helm'
          ? 'man'
          : view.owner.kind === 'dispatch'
            ? (`dispatch:${view.owner.chainId}` as const)
            : (`trap:${view.owner.trapId}` as const);
      stored.push({
        snapshot,
        watch: {
          key: view.key,
          owner,
          check: '',
          cursor: view.revision,
          createdAt: view.since,
          seen: 0,
          seenAt: 0,
          presentation: view.presentation,
        },
        events: [],
        pending: [],
      });
    }
  stored.push(...[...prior.values()].filter((view) => types.has(view.snapshot.type.id) && view.snapshot.status === 'held'));
  return stored;
}
