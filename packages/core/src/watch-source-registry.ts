import { localWatchTypes, type LocalWatchSources } from './local-watch-source.js';
import { createUmeWatchType, type UmeWatchSourceOptions } from './ume-watch-source.js';
import { CommandWatchType, MergePolicyWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { Watch } from './watch.js';
import { createStackWatchType, type StackWatchSourceOptions } from './stack-watch-source.js';
import { createPrMergeWatchType, type PrMergeWatchSourceOptions } from './pr-merge-watch-source.js';
import { createPrWatchType, type PrWatchSourceOptions } from './pr-watch-source.js';
import { createReviewWatchType, type ReviewWatchSourceOptions } from './review-watch-source.js';

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
  registry.register(createPrWatchType(options.pr));
  registry.register(createReviewWatchType(options.review));
  registry.register(createStackWatchType(options.stack));
  registry.register(createPrMergeWatchType(options.prMerge));
  registry.register(new MergePolicyWatchType());
  registry.register(createUmeWatchType(options.ume));
  for (const adapter of localWatchTypes(options.local)) registry.register(adapter);
  registry.register(new CommandWatchType());
  return registry;
}

/** Legacy imports use source-declared bindings; explicit registrations persist their type. */
export function watchSourceType(watch: Pick<Watch, 'typeId' | 'key' | 'check' | 'cursor'>, registry = builtinWatchRegistry()): string {
  for (const source of registry.list()) {
    if (
      !source.bindings.some(
        (binding) =>
          binding.event === 'legacy-command' &&
          (!watch.typeId || binding.importsType === watch.typeId) &&
          binding.pattern &&
          new RegExp(binding.pattern).test(watch.check),
      )
    )
      continue;
    if (source.identify(watch.key, { check: watch.check, cursor: watch.cursor })) return source.descriptor.id;
  }
  return watch.typeId ?? 'command';
}
