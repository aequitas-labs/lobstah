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
import { setChecklistSource } from './checklists.js';
import type { ChecklistSource } from './checklists.js';

export type { GlassRead, GlassVerdict, GlassWrite } from './answers.js';

/**
 * Where a glass reads and writes: the one seam between the UI and its host.
 * The local glass talks to its daemon (backends/local.ts); the hosted glass
 * talks to its wharf. Components and actions never fetch on their own.
 */
export interface GlassBackend {
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
  /** Documents' checklist progress: read and ticked. */
  checklists: ChecklistSource;
}

/** A poll's answer: a new snapshot (and its ETag), or `unchanged` with the beats an unchanged answer carried. */
export type GlassPoll =
  { kind: 'snapshot'; snapshot: GlassSnapshot; etag: string | null } | { kind: 'unchanged'; beats: GlassBeats | undefined };

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
