export const VERBS = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed'] as const;
export type Verb = (typeof VERBS)[number];
export const TERMINAL_VERBS: readonly Verb[] = ['done', 'failed'];

export type Lane = 'work' | 'chore';

export interface DispatchLimits {
  maxTurns?: number;
  maxBudgetUsd?: number;
  wallClockSecs?: number;
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
}

export interface StatusEntry {
  at: string;
  verb: Verb;
  note?: string;
}

export interface Evidence {
  sessionId?: string;
  branch?: string;
  commits?: string[];
  prUrl?: string;
  transcriptPath?: string;
  note?: string;
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
