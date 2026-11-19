import { syncLocalWatchSources, syncWatchSubscriptions } from '@lobstah/core';
import type { Lane, StatusEntry } from '@lobstah/core';
import { createCliWatchRegistry } from './watch-automation.js';
import { syncRegisteredWatches } from './watch-observation.js';
import { prWatchEffects } from './pr-watch-effects.js';
import { clearFinishedUmeWatches, registerUmeReview, syncUmeWatches } from './ume-watch.js';

/** Builtin source composition is separate from daemon scheduling and helm presentation. */
export function runCliWatchSources(now: number, log: (message: string) => void): void {
  const passes: Array<() => void> = [
    () => syncUmeWatches(),
    () => syncWatchSubscriptions(createCliWatchRegistry(log), now),
    () => syncLocalWatchSources(createCliWatchRegistry(log), now),
    () => {
      syncRegisteredWatches(now);
    },
    () => prWatchEffects(now, log),
  ];
  for (const pass of passes) {
    try {
      pass();
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Source registration handlers share the report boundary; the CLI owns no source cleanup policy. */
export function registerCliReportWatches(id: string, lane: Lane, entry: StatusEntry, enabled: boolean): void {
  if (enabled) registerUmeReview(id, lane, entry);
  clearFinishedUmeWatches();
}
