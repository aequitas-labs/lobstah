import { builtinWatchRegistry } from '@lobstah/core';
import type { WatchRegistry } from '@lobstah/watch-types';
import { prRepairWatchServices } from '../watch-sources/pr-repair.js';
import type { RepairOptions as RepairPolicyOptions } from '../pr-repair.js';
import { mergeCommands, mergeRegistration, stackRegistration } from './merge.js';
import { prWatchCommands } from './pr-commands.js';
import { prRegistration, prTriggerServices } from './pr.js';
import { umeRegistration, umeWatchCommands } from './ume.js';
import type { WatchProbeRun } from '../watch-command.js';
import { reviewRequestServices } from '../watch-sources/review-requests.js';
import type { ReviewHostEffects } from '../watch-sources/review-requests.js';

/** The glass's acknowledgement and merge paths, loaded when an effect runs so composition stays acyclic. */
const reviewHostEffects: ReviewHostEffects = {
  async acknowledgeAttention(key) {
    const [{ buildTendReport, walkingAttention }, { ackWalkingItem }] = await Promise.all([import('../tend.js'), import('../attention-ack.js')]);
    const standing = walkingAttention(buildTendReport()).find((item) => item.kind === 'review' && item.key === key && !item.acked);
    if (!standing) return false;
    await ackWalkingItem(standing, 'glass');
    return true;
  },
  async cancelMerge(prKey) {
    const { cancelPrMerge } = await import('../pr-merge.js');
    cancelPrMerge(prKey);
    return undefined;
  },
};
export interface RepairOptions extends RepairPolicyOptions { commandRun?: WatchProbeRun }

/** Shipped source services are installed only at this composition root. */
export function cliWatchRegistry(log: (message: string) => void, options: RepairOptions = {}): WatchRegistry {
  return builtinWatchRegistry({
    pr: { ...prRepairWatchServices(log, options), registration: prRegistration(log), triggers: prTriggerServices(), commands: prWatchCommands(options.commandRun) },
    prMerge: { commands: mergeCommands(false), registration: mergeRegistration(log) },
    stack: { commands: mergeCommands(true), registration: stackRegistration(log) },
    ume: { registration: umeRegistration(), commands: umeWatchCommands() },
    review: reviewRequestServices(() => cliWatchRegistry(log, options), reviewHostEffects),
  });
}
