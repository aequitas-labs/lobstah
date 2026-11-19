import type { WatchInstructions, WatchPresentation } from './model.js';

/** Navigation primitives belong to the shell; adapters provide their destination. */
export type WatchAttentionTarget =
  { href: string } | { hash: string } | { open: { type: 'dispatch' | 'trap' | 'helm' | 'pr' | 'review' | 'settings'; key: string } };

/** One source supplies a complete attention row, including how each audience acts. */
export interface WatchAttentionDisplay {
  family?: 'question' | 'decision' | 'landed' | 'report' | 'review' | 'pr' | 'stack' | 'notice' | 'dispatch';
  shared?: boolean;
  links?: Array<{ label: string; url: string }>;
  itemKey: string;
  text: string;
  label: string;
  cliKind: string;
  cliVerb: string;
  badgeText: string;
  badgeClass: string;
  afterBadge?: string;
  /** The generic row can show explicit viewing or acknowledgment without matching a source kind. */
  viewedBy?: 'viewedAt' | 'ack';
  target?: WatchAttentionTarget;
  acknowledge: boolean;
  always: boolean;
  blocking: boolean;
  enabledBy?: string[];
  suppressesKeys?: string[];
  /** Source rules can suppress one condition without hiding another kind on the same key. */
  suppresses?: Array<{ key: string; kind: string }>;
}

export { legacyAttentionLabels, legacyAttentionTones, presentLegacyAttention } from './adapters/presentation.js';
export type { LegacyAttentionRecord } from './adapters/presentation.js';

/** New types render from their supplied contract without joining a label or route map. */
export function presentWatchCondition(key: string, kind: string, summary: string, presentation: WatchPresentation): WatchAttentionDisplay {
  const tone = { neutral: 'dim', ok: 'ok', warning: 'warn', risk: 'bad' }[presentation.tone];
  const link = presentation.links[0];
  return {
    family: 'notice',
    shared: false,
    links: presentation.links.map(link => ({ ...link })),
    itemKey: `${kind}:${key}`,
    text: summary,
    label: presentation.label,
    cliKind: kind,
    cliVerb: kind,
    badgeText: presentation.label,
    badgeClass: `badge ${tone}`,
    ...(link ? { target: { href: link.url } } : {}),
    acknowledge: true,
    always: false,
    blocking: false,
  };
}

/** Role selection is generic; source-provided read commands remain structured data. */
export function watchInstructionLines(presentation: WatchPresentation | undefined, audience: 'worker' | 'helm'): string[] {
  if (!presentation) return [];
  const instructions: WatchInstructions = presentation[audience];
  return [...instructions.steps, ...(instructions.read ? [`read: ${JSON.stringify(instructions.read)}`] : [])];
}

/** A repeated standing condition keeps its age; a changed state starts a new one. */
export function retainWatchConditionTimes(next: WatchPresentation, previous: WatchPresentation, now: string): WatchPresentation {
  return {
    ...next,
    attention: next.attention.map((condition) => {
      const prior = previous.attention.find(
        (entry) => entry.id === condition.id && entry.kind === condition.kind && entry.stateHash === condition.stateHash,
      );
      return { ...condition, since: condition.since ?? prior?.since ?? now };
    }),
  };
}

/** Encode each identity component so source keys and condition IDs cannot alias. */
export function watchConditionKey(sourceKey: string, conditionId: string): string {
  return `watch:${encodeURIComponent(sourceKey)}:${encodeURIComponent(conditionId)}`;
}
