import type { WatchItem, WatchRegistry, WatchSnapshot, WatchSourceBrand, WatchSurface } from '@lobstah/watch-types';
import { journalWatchViews } from './watch-presentation.js';
import type { JournalWatchView } from './watch-presentation.js';
import { WatchRuntime } from './watch-runtime.js';

/**
 * One item on a glass surface, with the watch that supplied it. The watch
 * identity routes an action back to its source; the item's own ID is its
 * identity on the surface.
 */
export interface WatchSurfaceItem {
  watch: {
    key: string;
    generation: string;
    type: string;
    /** A held or closing watch keeps its last items visible, but its effects are disabled. */
    status: WatchSnapshot['status'];
  };
  source: WatchSourceBrand;
  item: WatchItem;
}

/**
 * The items every active watch supplies to a surface, read from cached
 * presentations only: no provider read, no plugin, no registry. Sources
 * that write presentation v1 contribute nothing here; they still appear in
 * Watches.
 */
export function watchSurfaceItems(surface: WatchSurface, views: readonly JournalWatchView[] = journalWatchViews()): WatchSurfaceItem[] {
  return views.flatMap(({ snapshot, view }) =>
    view.items
      .filter((item) => item.surfaces.list.includes(surface))
      .map((item) => ({
        watch: { key: snapshot.key, generation: snapshot.generation, type: snapshot.type.id, status: snapshot.status },
        source: view.source,
        item,
      })),
  );
}

/** A source's health on a surface: its setup and stale notices belong to it, not to the page. */
export interface WatchSurfaceSource {
  watch: WatchSurfaceItem['watch'];
  source: WatchSourceBrand;
  /** healthy; stale (its last read failed, so it shows its last good items); held (its observer is stopped). */
  health: 'healthy' | 'stale' | 'held';
  message?: string;
  remedy?: string;
}

/** Every source that contributes to a surface, whether or not it has items now, with its health. */
export function watchSurfaceSources(surface: WatchSurface, views: readonly JournalWatchView[] = journalWatchViews()): WatchSurfaceSource[] {
  return views.flatMap(({ snapshot, view }) => {
    if (view.version !== 2) return [];
    const contributes = snapshot.presentation.surfaces?.includes(surface) || view.items.some((item) => item.surfaces.list.includes(surface));
    if (!contributes) return [];
    const failure = snapshot.failure;
    const health = snapshot.status === 'held' ? 'held' : failure ? 'stale' : 'healthy';
    return [
      {
        watch: { key: snapshot.key, generation: snapshot.generation, type: snapshot.type.id, status: snapshot.status },
        source: view.source,
        health,
        ...(health !== 'healthy' && failure ? { message: failure.message, ...(failure.remedy ? { remedy: failure.remedy } : {}) } : {}),
      },
    ];
  });
}

/**
 * Re-present the in-process sources that supply items, before a page reads
 * their cached projections, so a local change shows at once. Plugins are
 * never started here; their items refresh when their watch is checked.
 */
export function refreshItemSources(registry: WatchRegistry, now = Date.now()): void {
  const runtime = new WatchRuntime(registry);
  for (const snapshot of runtime.journal.list()) {
    if (snapshot.status !== 'watching' || snapshot.presentation.version !== 2 || snapshot.type.installation) continue;
    try {
      runtime.represent(snapshot.key, now);
    } catch {
      // A source that cannot present keeps its last cached items; its next check reports the failure.
    }
  }
}
