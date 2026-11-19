import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { Watch } from './watch.js';
import { createPrWatchType } from './pr-watch-source.js';

/** The builtin composition root is the only place that names shipped source modules. */
export function builtinWatchRegistry(options: Parameters<typeof createPrWatchType>[0] = {}): WatchRegistry {
  const registry = new WatchRegistry();
  registry.register(createPrWatchType(options));
  registry.register(new CommandWatchType());
  return registry;
}

/** Legacy imports use source-declared bindings; explicit registrations persist their type. */
export function watchSourceType(watch: Pick<Watch, 'typeId' | 'key' | 'check' | 'cursor'>, registry = builtinWatchRegistry()): string {
  if (watch.typeId) return watch.typeId;
  for (const source of registry.list()) {
    if (
      !source.bindings.some(
        (binding) => binding.event === 'legacy-command' && binding.pattern && new RegExp(binding.pattern).test(watch.check),
      )
    )
      continue;
    if (source.identify(watch.key, { check: watch.check, cursor: watch.cursor })) return source.descriptor.id;
  }
  return 'command';
}
