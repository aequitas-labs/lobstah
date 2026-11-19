import type { WatchInstructions, WatchPresentation } from './model.js';

/** Navigation primitives belong to the shell; adapters provide their destination. */
export type WatchAttentionTarget =
  { href: string } | { hash: string } | { open: { type: 'dispatch' | 'trap' | 'helm' | 'pr' | 'review' | 'settings'; key: string } };

/** One source supplies a complete attention row, including how each audience acts. */
export interface WatchAttentionDisplay {
  itemKey: string;
  text: string;
  label: string;
  cliKind: string;
  cliVerb: string;
  badgeText: string;
  badgeClass: string;
  afterBadge?: string;
  target?: WatchAttentionTarget;
  acknowledge: boolean;
  always: boolean;
  blocking: boolean;
  enabledBy?: string[];
  suppressesKeys?: string[];
}

/** The compatibility adapter accepts legacy wire records without importing any app. */
export interface LegacyAttentionRecord {
  kind?: string;
  verb: string;
  key?: string;
  id?: string;
  lane?: string;
  note?: string;
  headline?: string;
  prUrl?: string;
  glass?: string;
  stack?: { allReady: boolean; members: Array<{ key: string }> };
}

interface LegacyKind {
  label: string;
  tone: string;
}
const legacyKinds: Readonly<Record<string, LegacyKind>> = {
  'pr:draft': { label: 'draft', tone: 'dim' },
  'pr:review': { label: 'review', tone: 'bad' },
  'pr:checks': { label: 'checks', tone: 'bad' },
  'pr:conflict': { label: 'conflicts', tone: 'pr-conflicts' },
  'pr:ready': { label: 'ready', tone: 'ok' },
  'stack-ready': { label: 'stack ready', tone: 'ok' },
  review: { label: 'review request', tone: 'dim' },
  landed: { label: 'landed', tone: 'dim' },
  watch: { label: 'watch', tone: 'warn' },
  report: { label: 'report', tone: 'dim' },
};

/** Older clients can retain their label exports without keeping another source map. */
export const legacyAttentionLabels: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(legacyKinds).map(([kind, value]) => [kind, value.label]),
);
export const legacyAttentionTones: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(legacyKinds).map(([kind, value]) => [kind, value.tone]),
);

/** Existing source policy is isolated here while its domain adapter migrates. */
export function presentLegacyAttention(record: LegacyAttentionRecord): WatchAttentionDisplay {
  const kind = record.kind ?? 'question',
    key = record.key;
  const definition = legacyKinds[kind];
  const display: WatchAttentionDisplay = {
    itemKey: `${kind}:${key ?? `${record.lane}:${record.id}`}`,
    text: record.note || record.verb,
    label: definition?.label ?? '',
    cliKind: kind === 'stack-ready' && record.stack && !record.stack.allReady ? 'stack-waiting' : kind,
    cliVerb: kind === 'question' || kind === 'watch' ? record.verb : kind === 'landed' ? `landed (${record.verb})` : kind,
    badgeText: kind === 'question' ? record.verb : definition?.label || kind,
    badgeClass:
      kind === 'question'
        ? `v-${record.verb}`
        : `badge ${kind === 'landed' ? (record.verb === 'failed' ? 'bad' : 'ok') : definition?.tone || 'dim'}`,
    acknowledge: true,
    always: kind === 'watch' || kind === 'dispatch-progress',
    blocking: ['question', 'decision', 'watch', 'dispatch-progress'].includes(kind),
  };
  if (kind === 'stack-ready') {
    display.enabledBy = ['pr:ready'];
    display.cliVerb = display.cliKind;
    display.suppressesKeys = record.stack?.members.map((member) => `watch:${member.key}`);
  }
  if (kind === 'landed') display.afterBadge = record.verb;
  if ((kind === 'decision' || kind === 'report') && key && record.glass) display.target = { href: record.glass };
  else if ((kind === 'decision' || kind === 'question') && key) display.target = { hash: `#decision/${encodeURIComponent(key)}` };
  else if ((kind === 'review' || kind === 'pr:draft') && key && record.prUrl) {
    display.target = { hash: `#pr/${encodeURIComponent(key.replace(/^review:/, 'pr:'))}` };
    display.acknowledge = kind === 'review';
  } else if (kind === 'report' && key) display.target = { href: `/report/${encodeURIComponent(key)}` };
  else if ((kind.startsWith('pr:') || kind === 'stack-ready') && record.prUrl) {
    display.target = { href: record.prUrl };
    display.itemKey = `${kind}:${key ?? record.prUrl}`;
    display.text = record.headline || record.note || kind;
  } else if (kind !== 'watch') display.target = { open: { type: 'dispatch', key: `${record.lane}:${record.id}` } };
  return display;
}

/** New types render from their supplied contract without joining a label or route map. */
export function presentWatchCondition(key: string, kind: string, summary: string, presentation: WatchPresentation): WatchAttentionDisplay {
  const tone = { neutral: 'dim', ok: 'ok', warning: 'warn', risk: 'bad' }[presentation.tone];
  const link = presentation.links[0];
  return {
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
