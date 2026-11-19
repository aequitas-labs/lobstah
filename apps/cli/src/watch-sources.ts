import { loadConfig, syncLocalWatchSources, syncWatchSubscriptions, syncWatchRegistrations, registerWatchEvent } from '@lobstah/core';
import type { Lane, StatusEntry } from '@lobstah/core';
import { createCliWatchRegistry, deliverRegisteredWatchActions } from './watch-automation.js';
import { syncRegisteredWatches } from './watch-observation.js';

/** Builtin source composition is separate from daemon scheduling and helm presentation. */
export function runCliWatchSources(now: number, log: (message: string) => void): void {
  const passes: Array<() => void> = [
    () => syncWatchRegistrations(createCliWatchRegistry(log), now, log),
    () => syncWatchSubscriptions(createCliWatchRegistry(log), now),
    () => syncLocalWatchSources(createCliWatchRegistry(log), now),
    () => {
      syncRegisteredWatches(now);
    },
    () => syncWatchRegistrations(createCliWatchRegistry(log), now, log, 'after-observe'),
    () => { deliverRegisteredWatchActions(now, loadConfig().watch.maxForksPerCycle, log); },
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
  const registry = createCliWatchRegistry(() => {});
  if (enabled) registerWatchEvent({ event: 'report', fields: JSON.parse(JSON.stringify(entry)), options: {}, owner: { kind: 'dispatch', chainId: id, grounds: 'home' } }, registry);
  syncWatchRegistrations(registry, Date.now(), () => {}, 'report');
}
