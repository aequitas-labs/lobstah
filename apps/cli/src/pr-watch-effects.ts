import { retireTerminalPrWatches } from '@lobstah/core';
import { observeWaitedPrs, finishResolvedWaits } from './pr-waits.js';
import { pollSecs } from './pr-watch.js';
import { stampRepairerBeat } from './pr-repair.js';

/** PR observation projections, wait completion and authorized actions are source-owned. */
export function prWatchEffects(now: number, log: (message: string) => void): void {
  retireTerminalPrWatches();
  observeWaitedPrs({ everySecs: pollSecs(), now });
  // Release on merge needs the chain's completed wait before the cull pass.
  finishResolvedWaits(log);
  stampRepairerBeat(now);
}
