import { builtinWatchRegistry, listWatches, restoreLegacyWatch, WatchAutomationRunner, WatchRuntime, watchSourceType } from '@lobstah/core';
import { prRepairWatchServices } from './watch-sources/pr-repair.js';
import type { WatchRegistry } from '@lobstah/watch-types';
import type { RepairOptions } from './pr-repair.js';

/** CLI hosts install the same source services for daemon and pickup execution. */
export function createCliWatchRegistry(log: (message: string) => void, options: RepairOptions = {}): WatchRegistry {
  return builtinWatchRegistry({ pr: prRepairWatchServices(log, options) });
}

/** Source capabilities select work; this host only preserves ordering and the scheduler cap. */
export function deliverRegisteredWatchActions(
  now: number,
  cap: number,
  log: (message: string) => void,
  options: RepairOptions = {},
): string[] {
  const registry = createCliWatchRegistry(log, { ...options, now: options.now ?? now }),
    runtime = new WatchRuntime(registry);
  const legacy = listWatches();
  for (const watch of legacy) if (registry.get(watchSourceType(watch, registry)).automation) restoreLegacyWatch(watch, runtime);
  const keys = [...legacy.map((watch) => watch.key), ...runtime.journal.list().map((snapshot) => snapshot.key)];
  const budget = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 3;
  return new WatchAutomationRunner(registry, runtime.journal).runSync(keys, now, budget, log);
}
