import { pluginDto, validateWatchFailure } from '@lobstah/watch-types';
import type { InstalledWatchType, WatchFailure } from '@lobstah/watch-types';

/** A broken error formatter must not abort other sources or erase the original checkpoint. */
export function sourceWatchFailure(source: Pick<InstalledWatchType, 'failure'> | undefined, error: unknown): WatchFailure {
  try {
    if (!source) throw error;
    return validateWatchFailure(pluginDto(source.failure(error)));
  } catch (failure) {
    return {
      kind: 'adapter',
      hold: true,
      message: error instanceof Error ? error.message : String(error),
      remedy: source
        ? `The adapter could not report this failure: ${failure instanceof Error ? failure.message : String(failure)}. Install a compatible adapter, then release the watch.`
        : 'Install a compatible watch adapter or restore its supported state version.',
    };
  }
}
