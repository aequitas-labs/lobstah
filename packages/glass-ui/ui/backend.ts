import type {
  GlassBeats,
  GlassDecision,
  GlassDispatch,
  GlassOlderKind,
  GlassOlderPage,
  GlassReport,
  GlassSettings,
  GlassSnapshot,
  StatsPage,
} from '@lobstah/core';
import type { GlassRead, GlassVerdict, GlassWrite } from './answers.js';
import { GLASS_TABS } from '../src/glass-diff.js';
import type { GlassTab } from '../src/glass-diff.js';
import { setChecklistSource } from './checklists.js';
import type { ChecklistSource } from './checklists.js';

export type { GlassRead, GlassVerdict, GlassWrite } from './answers.js';

/**
 * Where a glass reads and writes: the one seam between the UI and its host.
 * The local glass talks to its daemon (backends/local.ts); the hosted glass
 * talks to its wharf. Components and actions never fetch on their own.
 */
export interface GlassBackend {
  /** What this source can fill and do. The UI hides a tab or control it lacks; it never shows one empty. */
  capabilities: GlassCapabilities;
  /** How often the page polls while visible; 2 s when unset. */
  pollMs?: number;
  /** One poll. With the last ETag, an unchanged snapshot answers only its beats. Throws when the server answers an error. */
  poll(etag: string | null): Promise<GlassPoll>;
  /** The whole snapshot now, read once after a write so its result shows. */
  snapshot(): Promise<GlassSnapshot>;
  /** One dispatch's full record: its brief, log, inbox and evidence. */
  dispatch(id: string): Promise<GlassRead<GlassDispatch>>;
  /** A closed decision, opened by its deep link outside the live queue. */
  decision(key: string): Promise<GlassRead<GlassDecision>>;
  /** A page of history older than the snapshot holds. */
  older(kind: GlassOlderKind, offset: number, limit: number): Promise<GlassRead<GlassOlderPage>>;
  /** The Stats tab's numbers and heatmap. */
  stats(): Promise<GlassRead<StatsPage>>;
  /** The Settings tab's values, masked by the server. */
  settings(): Promise<GlassRead<GlassSettings>>;
  /** One glass request (an answer, a view, an ack, a trap request…), with the page's write token. */
  request<T extends GlassVerdict>(kind: string, payload: unknown, token: string): Promise<GlassWrite<T>>;
  /** Raise one live trap's window on this machine. */
  focus(trapId: string, token: string): Promise<GlassWrite<{ message?: string; reason?: string }>>;
  /** Report this page as open (and visible or not); the answer may hold a show for it. */
  presence(page: string, visible: boolean, app: boolean): Promise<GlassRead<{ show?: unknown } | null>>;
  /** A report's row, and the write token its page acks with. */
  report(key: string): Promise<GlassRead<GlassReport> & { token?: string }>;
  /** A report's Markdown. */
  reportText(key: string): Promise<GlassRead<string>>;
  /** Documents' checklist progress: read and ticked. Absent, tasks show as written and read-only. */
  checklists?: ChecklistSource;
  /** Where the browser loads a file the glass lists: a decision's, a report's, a dispatch's or a trap's. */
  fileUrl(owner: GlassFileOwner, name: string): string;
}

/** What a listed file belongs to, as fileUrl names it. */
export type GlassFileOwner =
  { kind: 'decision' | 'report'; key: string } | { kind: 'dispatch'; lane: string; id: string } | { kind: 'trap'; trapId: string };

/** A poll's answer: a new snapshot (and its ETag), or `unchanged` with the beats an unchanged answer carried. */
export type GlassPoll =
  { kind: 'snapshot'; snapshot: GlassSnapshot; etag: string | null } | { kind: 'unchanged'; beats: GlassBeats | undefined };

/** The tabs a source fills, and the actions it takes beyond reading. */
export interface GlassCapabilities {
  /** The tabs shown, in GLASS_TABS order. A hash for any other tab opens the deck. */
  tabs: readonly GlassTab[];
  /** The controls shown. A control for an action not listed here does not render. */
  actions: ReadonlySet<GlassAction>;
  /** The source runs a daemon on this machine, whose heartbeat the header shows. */
  daemon: boolean;
}

/** The actions a glass can offer that not every source takes. */
export const GLASS_ACTIONS = [
  /** Raise a live trap's window on this machine. */
  'focus',
  /** Ask the helm for a new trap. */
  'trap-request',
  /** Set or move a TODO's time. */
  'todo-schedule',
  /** Acknowledge PR and stack attention. */
  'pr-ack',
  /** Merge one of your PRs when it's green, or cancel that. */
  'pr-merge',
  /** Merge a whole stack of your PRs once every one is green, or cancel that. */
  'stack-merge',
  /** Acknowledge the item a clicked lob walked, so the pet and every glass stop walking it. */
  'attention-ack',
  /** Ask for, see or dismiss a review round. */
  'review-request',
  /** Attach files to a decision's answer. */
  'answer-files',
  /** Page in history older than the snapshot. */
  'older',
  /** Report this page's presence, so the pet can show an item in it. */
  'presence',
  /** Queue a message for the helm about a job, from its modal. */
  'message-helm',
  /** Cancel a job from its modal, fencing its worker. */
  'cancel',
  /** Ask the boat that drafted a review to dismiss it. */
  'review-dismiss',
  /** Mute or unmute all review rounds for one PR. */
  'review-mute',
  'review-unmute',
  /** Run a run card's script on this Mac. Only the local glass runs anything. */
  'run',
] as const;
export type GlassAction = (typeof GLASS_ACTIONS)[number];

/** Everything: the local daemon fills every tab and takes every action. */
export const ALL_CAPABILITIES: GlassCapabilities = {
  tabs: GLASS_TABS.filter((t) => t !== 'boats'),
  actions: new Set(GLASS_ACTIONS.filter((a) => !['message-helm', 'cancel', 'review-dismiss'].includes(a))),
  daemon: true,
};

let current: GlassBackend | undefined;

/** Choose the page's backend, once, before it starts. */
export function setBackend(backend: GlassBackend): void {
  current = backend;
  setChecklistSource(backend.checklists);
}

/** The page's backend. A page that never chose one fails loudly rather than fetching from a guessed host. */
export function backend(): GlassBackend {
  if (!current) throw new Error('The glass has no backend; call setBackend before starting it.');
  return current;
}

/** Whether this page's source takes an action. Before a backend is set (the hosted glass's own pages), nothing optional shows. */
export const can = (action: GlassAction): boolean => current?.capabilities.actions.has(action) ?? false;

/** This page's source's capabilities; everything before a backend is set. */
export const capabilities = (): GlassCapabilities => current?.capabilities ?? ALL_CAPABILITIES;

/** The tabs this page shows. */
export const visibleTabs = (): readonly GlassTab[] => current?.capabilities.tabs ?? GLASS_TABS;

/** Where this page loads a listed file. */
export const fileUrl = (owner: GlassFileOwner, name: string): string => backend().fileUrl(owner, name);
