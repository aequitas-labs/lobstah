import type { PrEvidence } from './pr.js';
export const VERBS = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed'] as const;
export type Verb = (typeof VERBS)[number];
export const TERMINAL_VERBS: readonly Verb[] = ['done', 'failed'];

export type Lane = 'work' | 'chore';

export interface DispatchLimits {
  maxTurns?: number;
  maxBudgetUsd?: number;
  wallClockSecs?: number;
}

export interface Attachment {
  name: string;
  path: string;
  bytes: number;
  type: string;
}

export interface Descriptor {
  id: string;
  repo: string;
  brief: string;
  harness?: string;
  model?: string;
  effort?: string;
  limits?: DispatchLimits;
  flags?: string[];
  env?: Record<string, string>;
  followUp?: string;
  attachments?: Attachment[];
  /** Address this bait to a specific claimant (`session:<id>`). A live
   * soaking session claims it; once its registration is gone the daemon
   * treats the bait as unaddressed. */
  for?: string;
}

export interface StatusEntry {
  at: string;
  verb: Verb;
  note?: string;
}

export interface Evidence {
  sessionId?: string;
  /** The harness that owns `sessionId` — stamped on first run (the adapter's
   * for a headless run, the trap's for a trap-claimed catch). A resume only
   * works under this harness; see resolveSessionHarness. */
  harness?: string;
  /** Set when a resume could not happen and the run started cold instead. */
  resumeFallback?: string;
  branch?: string;
  commits?: string[];
  prUrl?: string;
  transcriptPath?: string;
  note?: string;
  /** Delivery receipt: the trap address that actually claimed this dispatch. */
  deliveredTo?: string;
  deliveredAt?: string;
  /** The PR's state as last observed by its `pr:` watch (see pr.ts). */
  pr?: PrEvidence;
}

export type EventType =
  | 'session'
  | 'turn-start'
  | 'turn-end'
  | 'tool-start'
  | 'tool-end'
  | 'text'
  | 'error'
  | 'runner';

export interface NormalizedEvent {
  at: string;
  type: EventType;
  data?: Record<string, unknown>;
}

export interface RunnerInfo {
  pid: number;
  startedAt: string;
  processStartTime?: string;
  attempts: number;
}
