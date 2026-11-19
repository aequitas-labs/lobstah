import { builtinWatchRegistry } from '@lobstah/core';
import type { WatchRegistry } from '@lobstah/watch-types';
import { prRepairWatchServices } from '../watch-sources/pr-repair.js';
import type { RepairOptions } from '../pr-repair.js';
import { prRegistration } from './pr.js';
import { umeRegistration } from './ume.js';
export type { RepairOptions };

/** Shipped source services are installed only at this composition root. */
export function cliWatchRegistry(log: (message: string) => void, options: RepairOptions = {}): WatchRegistry {
  return builtinWatchRegistry({
    pr: { ...prRepairWatchServices(log, options), registration: prRegistration(log) },
    ume: { registration: umeRegistration() },
  });
}
