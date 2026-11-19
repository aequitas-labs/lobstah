import { loadConfig, retireTerminalPrWatches, syncStackReadiness } from '@lobstah/core';
import { observeWaitedPrs, finishResolvedWaits } from './pr-waits.js';
import { deliverRegisteredWatchActions } from './watch-automation.js';
import { pollSecs } from './pr-watch.js';
import { stampRepairerBeat } from './pr-repair.js';
import { mergeRequestedPrs, mergeRequestedStacks } from './pr-merge.js';

/** Existing PR effects stay source-owned while their policy and authority slices migrate. */
export function legacyPrWatchEffects(now: number, log: (message: string) => void): void {
  retireTerminalPrWatches();
  syncStackReadiness(loadConfig(), now);
  observeWaitedPrs({ everySecs: pollSecs(), now });
  // Release on merge needs the chain's completed wait before the cull pass.
  finishResolvedWaits(log);
  deliverRegisteredWatchActions(now, loadConfig().watch.maxForksPerCycle, log);
  mergeRequestedPrs(log);
  mergeRequestedStacks(log);
  stampRepairerBeat(now);
}
