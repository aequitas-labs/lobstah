import { runWatchCycle } from '@lobstah/core';
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
