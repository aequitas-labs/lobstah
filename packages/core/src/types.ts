import type { PrEvidence } from './pr.js';
import type { PushRecord } from './pushes.js';
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

/** The PR a dispatch works on: its URL, head branch, and the head it starts from. */
export interface DescriptorPr {
  url: string;
  headRefName?: string;
  headSha?: string;
}

export interface Descriptor {
  id: string;
  repo: string;
  brief: string;
  harness?: string;
  /** `harness` was named on the command line (`dispatch`/`swap --harness`),
   * not inherited from a default. An explicit harness that differs from a
   * follow-up origin's session is a swap: it starts cold on the one asked for. */
  harnessExplicit?: boolean;
  model?: string;
  /** `model` was named on the command line (`--model`). */
  modelExplicit?: boolean;
  effort?: string;
  limits?: DispatchLimits;
  flags?: string[];
  env?: Record<string, string>;
  followUp?: string;
  /**
   * The existing PR this dispatch works on (a repair or a rebase). The
   * runner pushes no branch and opens no PR for it; the worker pushes to
   * the PR's head branch.
   */
  pr?: DescriptorPr;
  attachments?: Attachment[];
  /** Address this bait to a specific claimant (`session:<id>`). A live
   * soaking session claims it; once its registration is gone the daemon
   * treats the bait as unaddressed. */
  for?: string;
  /** When the descriptor entered the queue (ISO). `enqueue` stamps it.
   * Older descriptors lack it; `queuedAt()` falls back to the file mtime. */
  queuedAt?: string;
}

/** What a paused (or questioning) worker waits on, outside lobstah. */
export const WAITING_ON = ['review', 'pr', 'deploy', 'person', 'external'] as const;
export type WaitingOn = (typeof WAITING_ON)[number];
/** The verbs that may say what they wait on (`--waiting-on`, `--link`). */
export const WAITING_ON_VERBS: readonly Verb[] = ['paused', 'needs-decision', 'blocked'];

export interface StatusEntry {
  at: string;
  verb: Verb;
  note?: string;
  /** What the worker waits on (paused, needs-decision, blocked only). */
  waitingOn?: WaitingOn;
  /** Where to look: the review, the PR, the deploy (http or https). */
  link?: string;
  /** When a pause expires (ISO). paused only; the ghost sweep honors it. */
  until?: string;
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
  /** The checkout the dispatch ran in (headless dispatches only). */
  worktree?: string;
  /** Set when the dispatch reused an earlier dispatch's worktree: that dispatch's id. */
  worktreeOf?: string;
  /** When `[limits].releaseOnMerge` removed the worktree after the PR merged (ISO). */
  worktreeReleased?: string;
  /** Branches this dispatch pushed, as lobstah saw it (pushes.ts). */
  pushes?: PushRecord[];
  /**
   * Set when the runner stopped the harness after the worker's final report:
   * why, and how long after the report.
   */
  harnessStopped?: { reason: 'exit-grace' | 'cancel'; afterSecs: number; at: string };
}

export type EventType =
  | 'session'
  | 'turn-start'
  | 'turn-end'
  /** Live background work changed: `data.live` counts tasks that are activity. */
  | 'background'
  | 'tool-start'
  | 'tool-end'
  | 'text'
  /** The model is reasoning. Carries no content. */
  | 'thinking'
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
