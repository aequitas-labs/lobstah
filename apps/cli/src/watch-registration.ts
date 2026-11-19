import type { WatchCommandRequest } from '@lobstah/watch-types';
import { journalWatchViews, readWatch, registerInstalledWatch, WatchJournal } from '@lobstah/core';
import type { Watch } from '@lobstah/core';
import { createCliWatchRegistry } from './watch-automation.js';

/** Every CLI registration honors the installed source, including replacements for shipped types. */
export function addCliWatch(
  input: string,
  options: { forId?: string; everySecs?: number; cursor?: string; cwd?: string; options?: Record<string, unknown> } = {},
): Watch {
  const previous = readWatch(input);
  const stored = new WatchJournal().read(input);
  const priorOwner = (stored?.status !== 'retired' ? stored?.owner : undefined) ?? (previous ? {
    grounds: previous.grounds ?? 'home',
    ...(previous.owner.startsWith('dispatch:') ? { kind: 'dispatch' as const, chainId: previous.owner.slice(9) } :
      previous.owner.startsWith('trap:') ? { kind: 'trap' as const, trapId: previous.owner.slice(5) } : { kind: 'helm' as const }),
  } : undefined);
  const snapshot = registerInstalledWatch(
    input,
    options.forId ? { kind: 'dispatch', chainId: options.forId, grounds: 'home' } : priorOwner ?? { kind: 'helm', grounds: 'home' },
    options.options ?? {},
    undefined,
    createCliWatchRegistry(() => {}),
    { everySecs: options.everySecs, cursor: options.cursor, cwd: options.cwd },
  );
  if (!snapshot) throw new Error(`No installed watch type recognizes ${input}.`);
  return readWatch(snapshot.key) ?? journalWatchViews().find((view) => view.watch.key === snapshot.key)!.watch;
}

/** Source-owned compatibility commands are selected from the same installed registry. */
export function runCliWatchCommand(request: WatchCommandRequest): string | undefined {
  const matches = createCliWatchRegistry(() => {})
    .list()
    .filter((source) =>
      source.commands?.bindings.some(
        (binding) => binding.name === request.name && (!binding.pattern || new RegExp(binding.pattern).test(request.args[0] ?? '')),
      ),
    );
  if (matches.length > 1) throw new Error('Several watch types handle this command.');
  return matches[0]?.commands?.run(request);
}
