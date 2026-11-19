import { builtinWatchRegistry, WatchJournal } from '@lobstah/core';
import type { WatchRegistry } from '@lobstah/watch-types';
import type { DoctorRow } from './doctor.js';

/** Validate installed versions without polling providers or modifying stored state. */
export function watchDoctorRow(registry: WatchRegistry = builtinWatchRegistry()): DoctorRow {
  const watches = new WatchJournal().list(),
    errors: string[] = [];
  for (const snapshot of watches) {
    if (snapshot.status === 'retired') continue;
    if (snapshot.status === 'held' && snapshot.failure) {
      errors.push(`${snapshot.key}: ${snapshot.failure.message}${snapshot.failure.remedy ? ` — ${snapshot.failure.remedy}` : ''}`);
      continue;
    }
    try {
      const source = registry.get(snapshot.type.id);
      try {
        source.restore(snapshot);
      } catch (error) {
        const failure = source.failure(error);
        errors.push(`${snapshot.key}: ${failure.message}${failure.remedy ? ` — ${failure.remedy}` : ''}`);
        continue;
      }
      if (snapshot.status === 'held')
        errors.push(
          `${snapshot.key}: ${snapshot.failure?.message ?? 'held'}${snapshot.failure?.remedy ? ` — ${snapshot.failure.remedy}` : ''}`,
        );
    } catch (error) {
      errors.push(`${snapshot.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    check: 'watch types',
    status: errors.length ? 'warn' : watches.length ? 'ok' : 'skip',
    detail: errors.length
      ? errors.join('; ')
      : watches.length
        ? registry
            .list()
            .map((source) => `${source.descriptor.id} ${source.descriptor.version} (state ${source.descriptor.stateVersion})`)
            .join('; ')
        : 'no stored watches',
  };
}
