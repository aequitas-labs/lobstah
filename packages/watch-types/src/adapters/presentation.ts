import type { WatchAttentionDisplay } from '../presentation.js';

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
  reviewUrl?: string;
  glass?: string;
  stack?: { allReady: boolean; members: Array<{ key: string }> };
}

interface LegacyKind {
  label: string;
  tone: string;
  family?: WatchAttentionDisplay['family'];
}
const legacyKinds: Readonly<Record<string, LegacyKind>> = {
  'pr:draft': { family: 'pr', label: 'draft', tone: 'dim' },
  'pr:review': { family: 'pr', label: 'review', tone: 'bad' },
  'pr:checks': { family: 'pr', label: 'checks', tone: 'bad' },
  'pr:conflict': { family: 'pr', label: 'conflicts', tone: 'pr-conflicts' },
  'pr:ready': { family: 'pr', label: 'ready', tone: 'ok' },
  'stack-ready': { family: 'stack', label: 'stack ready', tone: 'ok' },
  review: { family: 'review', label: 'review request', tone: 'dim' },
  landed: { family: 'landed', label: 'landed', tone: 'dim' },
  watch: { family: 'notice', label: 'watch', tone: 'warn' },
  report: { family: 'report', label: 'report', tone: 'dim' },
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
  const family =
    definition?.family ??
    ({ question: 'question', decision: 'decision', 'dispatch-progress': 'dispatch' } as const)[
      kind as 'question' | 'decision' | 'dispatch-progress'
    ];
  const display: WatchAttentionDisplay = {
    ...(family ? { family } : {}),
    shared: family === 'pr' || family === 'stack',
    links: [
      ...(record.prUrl ? [{ label: 'Open PR', url: record.prUrl }] : []),
      ...(record.reviewUrl ? [{ label: 'Open review', url: record.reviewUrl }] : []),
    ],
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
    ...(['question', 'decision'].includes(kind)
      ? { viewedBy: 'viewedAt' as const }
      : kind === 'report'
        ? { viewedBy: 'ack' as const }
        : {}),
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

/** Legacy browser identity mapping is owned by the presentation adapter. */
export function legacyPrKey(key: string): string { return key.replace(/^review:/, 'pr:'); }
export function legacyReviewKey(key: string): string { return key.replace(/^pr:/, 'review:'); }
export function legacyStackKey(id: string): string { return `stack:${id}`; }
export function legacyPrKeyMatches(key: string): boolean { return key.startsWith('pr:'); }
export function legacyPrAttention(kind: string): boolean { return kind.startsWith('pr:') || kind === 'stack-ready'; }
export function legacyPrItemKey(key: string): boolean { return /^(pr:|stack:)/.test(key); }
