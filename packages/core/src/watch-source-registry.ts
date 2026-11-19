import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { Watch } from './watch.js';
import { createPrWatchType, type PrWatchSourceOptions } from './pr-watch-source.js';
import { createReviewWatchType, type ReviewWatchSourceOptions } from './review-watch-source.js';

export interface BuiltinWatchServices {
  pr?: PrWatchSourceOptions;
  review?: ReviewWatchSourceOptions;
}

/** The builtin composition root is the only place that names shipped source modules. */
export function builtinWatchRegistry(options: BuiltinWatchServices = {}): WatchRegistry {
  const registry = new WatchRegistry();
  registry.register(createPrWatchType(options.pr));
  registry.register(createReviewWatchType(options.review));
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
