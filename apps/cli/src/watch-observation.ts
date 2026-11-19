import { runWatchCycle, readWatchEvents, removeWatch, watchErrorText, syncWatchRegistrations } from '@lobstah/core';
import { createCliWatchRegistry } from './watch-automation.js';
import type { Watch, WatchEvent } from '@lobstah/core';
import fs from 'node:fs';
import { parse } from 'smol-toml';
import { configPath } from '@lobstah/core';

/** All feeders retain the existing pickup cadence; bad values use 45 seconds. */
export function watchPollSecs(): number {
  try {
    const raw = parse(fs.readFileSync(configPath(), 'utf8'));
    const value = Number((raw.pickup as { pollSecs?: unknown } | undefined)?.pollSecs ?? 45);
    return Number.isFinite(value) && value > 0 ? value : 45;
  } catch {
    return 45;
  }
}

/** The daemon invokes one observation pass, independent of installed source kinds. */
export function syncRegisteredWatches(now = Date.now()): Array<{ watch: Watch; fresh: WatchEvent[] }> {
  return runWatchCycle(watchPollSecs(), new Date(now));
}

/** Inline waits poll every installed source and retain source-owned reconciliation. */
export function runDueWatches(log: (message: string) => void = message => console.error(message)): void {
  try {
    for (const { watch } of syncRegisteredWatches()) {
      if (watch.lastError) log(`lobstah: watch poll failed: ${watchErrorText(watch)}; still waiting`);
      if (watch.done && readWatchEvents(watch.key).length <= watch.seen) removeWatch(watch.key);
    }
    syncWatchRegistrations(createCliWatchRegistry(log), Date.now(), log, 'after-observe');
  } catch (error) {
    log(`lobstah: watch poll failed: ${error instanceof Error ? error.message : String(error)}; still waiting`);
  }
}
