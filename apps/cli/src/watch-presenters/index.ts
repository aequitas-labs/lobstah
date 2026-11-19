import { builtinWatchRegistry, prBadge, prNote } from '@lobstah/core';
import type { Config, Watch, WatchPresentation } from '@lobstah/core';
import { presentPrWatch, prAttention } from './pr.js';
import type { observedPrs, PrAttentionGraph } from './pr.js';

/** Temporary source presenters share one seam while their records migrate. */
const presenters: ReadonlyArray<(watch: Watch) => WatchPresentation | undefined> = [presentPrWatch];

export function presentRegisteredWatch(watch: Watch): WatchPresentation | undefined {
  for (const present of presenters) {
    const result = present(watch);
    if (result) return result;
  }
  return watch.presentation;
}


/** Builtin presenter composition supplies legacy ports; renderers consume only the contract. */
export function presentationSources(now: number, observed: ReturnType<typeof observedPrs>, cfg: Config, graph: PrAttentionGraph) {
  const attention = prAttention(now, observed, cfg, graph);
  const registry = builtinWatchRegistry({
    stack: {
      config: () => cfg,
      records: () => observed.map((entry) => entry.pr),
      member(pr) {
        const items = attention.filter((item) => item.prUrl === pr.url);
        return { kinds: items.map((item) => item.kind), note: items.map((item) => item.note).join('; ') || prNote(pr, prBadge(pr).text) };
      },
      owner(pr) {
        const entry = observed.find((entry) => entry.pr.url === pr.url);
        return { id: entry?.id ?? pr.url, lane: entry?.lane ?? 'work' };
      },
    },
  });
  return { attention, registry };
}
