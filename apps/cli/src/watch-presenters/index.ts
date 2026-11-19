import type { Watch, WatchPresentation } from '@lobstah/core';
import { presentPrWatch } from './pr.js';

/** Temporary source presenters share one seam while their records migrate. */
const presenters: ReadonlyArray<(watch: Watch) => WatchPresentation | undefined> = [presentPrWatch];

export function presentRegisteredWatch(watch: Watch): WatchPresentation | undefined {
  for (const present of presenters) {
    const result = present(watch);
    if (result) return result;
  }
  return watch.presentation;
}
