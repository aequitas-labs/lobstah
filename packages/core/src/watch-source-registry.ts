import type { Watch } from './watch.js';
import { builtinWatchRegistry } from './watch-adapters/registry.js';
export { builtinWatchRegistry } from './watch-adapters/registry.js';
export type { BuiltinWatchServices } from './watch-adapters/registry.js';

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
