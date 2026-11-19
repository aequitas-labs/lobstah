import { hideFramedQuestions } from '../decisions.js';
import { hostedAttention, hostedDecisionFrames } from '../hosted-view.js';
import { builtinWatchRegistry, prBadge, prNote, WatchJournal, watchSourceType, localQuestionAttention, listDecisions } from '@lobstah/core';
import type { Config, Watch, WatchPresentation, LocalWatchSources } from '@lobstah/core';
import { presentPrWatch, prAttention } from './pr.js';
import type { observedPrs, PrAttentionGraph } from './pr.js';

/** Read through the installed contract without registering, polling or matching a source prefix. */
export function presentRegisteredWatch(watch: Watch, registry = builtinWatchRegistry()): WatchPresentation | undefined {
  const stored = new WatchJournal().read(watch.key);
  try {
    const source = registry.get(stored?.type.id ?? watchSourceType(watch, registry));
    if (stored) return source.present(source.restore(stored));
    const identified = source.identify(watch.key, { check: watch.check, cursor: watch.cursor, legacy: JSON.parse(JSON.stringify(watch)) });
    if (!identified) return watch.presentation;
    return source.present({
      ...identified,
      key: identified.key,
      type: source.descriptor,
      owner: { kind: 'helm', grounds: watch.grounds ?? 'home' },
      generation: watch.generation ?? watch.createdAt,
      status: 'watching',
      events: [],
      deliveries: [],
      createdAt: watch.createdAt,
      failures: watch.failures ?? 0,
      presentation: watch.presentation!,
    });
  } catch {
    return stored?.presentation ?? watch.presentation;
  }
}

/** Builtin presenter composition supplies legacy ports; renderers consume only the contract. */
export function presentationSources(
  now: number,
  observed: ReturnType<typeof observedPrs>,
  cfg: Config,
  graph: PrAttentionGraph,
  local: LocalWatchSources = {},
) {
  const attention = prAttention(now, observed, cfg, graph);
  const registry = builtinWatchRegistry({
    local: {
      ...local,
      config: () => cfg,
      suppressions(at) {
        if (!cfg.attentionKinds.includes('decision')) return [];
        const questions = [...localQuestionAttention(at), ...hostedAttention(cfg, at).filter((item) => item.kind === 'question')];
        const retained = new Set(
          hideFramedQuestions(questions, [...listDecisions(), ...hostedDecisionFrames(cfg)]).map((item) => item.key),
        );
        return questions.filter((item) => !retained.has(item.key)).map((item) => ({ kind: item.kind, key: item.key }));
      },
    },
    pr: {
      present(snapshot) {
        return presentPrWatch({
          key: snapshot.key,
          owner: 'man',
          check: snapshot.options.check,
          cursor: snapshot.cursor,
          seen: 0,
          seenAt: 0,
          createdAt: snapshot.createdAt,
        })!;
      },
    },
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

export { evidencePrs, observedPrs, onTheHook, prKinds, humanPrAttention } from './pr.js';
export type { ChainMember } from './pr.js';
export { deriveGlassPrs } from '../glass-prs.js';
export type { GlassStack } from '../glass-prs.js';

export type SourceTendCache = ReturnType<typeof import('../watch-adapters/pr-tend.js').cachedPrPresentation>;
