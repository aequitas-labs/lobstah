import { loadConfig } from '../config.js';
import { storedWatchTypeDescriptors, storeWatchTypeDescriptor } from '../watch-type-descriptors.js';
import { localWatchTypes, type LocalWatchSources } from '../local-watch-source.js';
import { createUmeWatchType, type UmeWatchSourceOptions } from '../ume-watch-source.js';
import {
  CommandWatchType,
  MergePolicyWatchType,
  WatchRegistry,
  UnavailableWatchType,
  createProcessWatchType,
  parseWatchPluginConfiguration,
  watchPluginDefaults,
} from '@lobstah/watch-types';
import type { BaseWatchType } from '@lobstah/watch-types';
import { createStackWatchType, type StackWatchSourceOptions } from '../stack-watch-source.js';
import { createPrMergeWatchType, type PrMergeWatchSourceOptions } from '../pr-merge-watch-source.js';
import { createPrWatchType, type PrWatchSourceOptions } from '../pr-watch-source.js';
import { createReviewWatchType, type ReviewWatchSourceOptions } from '../review-watch-source.js';

export interface BuiltinWatchServices {
  local?: LocalWatchSources;
  ume?: UmeWatchSourceOptions;
  stack?: StackWatchSourceOptions;
  prMerge?: PrMergeWatchSourceOptions;
  pr?: PrWatchSourceOptions;
  review?: ReviewWatchSourceOptions;
}

/** The builtin composition root is the only place that names shipped source modules. */
export function builtinWatchRegistry(options: BuiltinWatchServices = {}): WatchRegistry {
  const registry = new WatchRegistry();
  const configuration = loadConfig().watchTypes ?? {};
  const prior = new Map(storedWatchTypeDescriptors().map((descriptor) => [descriptor.id, descriptor]));
  const remaining = new Set(Object.keys(configuration));
  function installBuiltin<Reference, State, Cursor, Options>(builtin: BaseWatchType<Reference, State, Cursor, Options>): void {
    const id = builtin.descriptor.id,
      settings = configuration[id];
    remaining.delete(id);
    if (
      !settings ||
      (settings.enabled !== false && (!settings.module || settings.module === 'builtin' || settings.module === `builtin:${id}`))
    ) {
      registry.register(builtin);
      return;
    }
    const adapter =
      settings.enabled !== false && settings.module === 'process'
        ? createProcessWatchType(
            parseWatchPluginConfiguration(id, settings),
            watchPluginDefaults(settings),
            prior.get(id) ?? builtin.descriptor,
          )
        : new UnavailableWatchType(prior.get(id) ?? builtin.descriptor, {
            kind: 'installation',
            hold: true,
            message:
              settings.enabled === false ? `Watch type ${id} is disabled.` : `Watch module ${String(settings.module)} is unavailable.`,
            remedy: `Enable a compatible installation in [watchTypes.${id}], then release its held watches.`,
          });
    registry.register(adapter);
  }
  installBuiltin(createPrWatchType(options.pr));
  installBuiltin(createReviewWatchType(options.review));
  installBuiltin(createStackWatchType(options.stack));
  installBuiltin(createPrMergeWatchType(options.prMerge));
  installBuiltin(new MergePolicyWatchType());
  installBuiltin(createUmeWatchType(options.ume));
  for (const adapter of localWatchTypes(options.local)) installBuiltin(adapter);
  installBuiltin(new CommandWatchType());
  for (const id of remaining) {
    const settings = configuration[id]!;
    const adapter =
      settings.enabled !== false && settings.module === 'process'
        ? createProcessWatchType(parseWatchPluginConfiguration(id, settings), watchPluginDefaults(settings), prior.get(id))
        : new UnavailableWatchType(prior.get(id) ?? { id, apiVersion: 1, stateVersion: 1, version: 'unavailable' }, {
            kind: 'installation',
            hold: true,
            message: `Watch type ${id} has no enabled installation.`,
            remedy: `Configure an enabled process module in [watchTypes.${id}], then release its held watches.`,
          });
    registry.register(adapter);
    if (!(adapter instanceof UnavailableWatchType)) storeWatchTypeDescriptor(adapter.descriptor);
  }
  return registry;
}
