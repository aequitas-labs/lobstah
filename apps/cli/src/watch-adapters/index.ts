import { builtinWatchRegistry } from '@lobstah/core';
import type { WatchRegistry } from '@lobstah/watch-types';
import { prRepairWatchServices } from '../watch-sources/pr-repair.js';
import type { RepairOptions as RepairPolicyOptions } from '../pr-repair.js';
import { mergeCommands, mergeRegistration, stackRegistration } from './merge.js';
import { prWatchCommands } from './pr-commands.js';
import { prRegistration, prTriggerServices } from './pr.js';
import { umeRegistration, umeWatchCommands } from './ume.js';
import type { WatchProbeRun } from '../watch-command.js';
export interface RepairOptions extends RepairPolicyOptions { commandRun?: WatchProbeRun }

/** Shipped source services are installed only at this composition root. */
export function cliWatchRegistry(log: (message: string) => void, options: RepairOptions = {}): WatchRegistry {
  return builtinWatchRegistry({
    pr: { ...prRepairWatchServices(log, options), registration: prRegistration(log), triggers: prTriggerServices(), commands: prWatchCommands(options.commandRun) },
    prMerge: { commands: mergeCommands(false), registration: mergeRegistration(log) },
    stack: { commands: mergeCommands(true), registration: stackRegistration(log) },
    ume: { registration: umeRegistration(), commands: umeWatchCommands() },
  });
}
