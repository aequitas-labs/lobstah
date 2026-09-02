import type { Evidence, Verb } from '@lobstah/core';

export interface WorkItem {
  /** Stable tracker key, e.g. "linear:BAS-12" or "gh:owner/repo#34". */
  key: string;
  kind: 'issue' | 'review';
  /** Lobstah repo key, resolved by the source from its routing config. */
  repoKey: string;
  title: string;
  brief: string;
  /** For review items: the implementation dispatch to fork (from the lobstah/<uuid> branch name). */
  followUp?: string;
}

export interface TrackedItem {
  key: string;
  open: boolean;
}

/** A source translates tracker vocabulary to lobstah vocabulary and nothing else. */
export interface Source {
  name: string;
  poll(): Promise<WorkItem[]>;
  /** Tracker-side state transition — the cross-machine mutex. */
  claim(item: WorkItem): Promise<boolean>;
  /** Report embeds the dispatch UUID in the tracker trail, making the mapping reconstructible. */
  report(key: string, verb: Verb, evidence: Evidence & { uuid: string }): Promise<void>;
  inbound(key: string, since?: string): Promise<string[]>;
  /** Items the tracker currently attributes to pickup — the reconcile surface. */
  inProgress(): Promise<TrackedItem[]>;
  /** Rebuild path: recover a UUID from the tracker trail (report markers). */
  recoverUuid(key: string): Promise<string | undefined>;
  /** Orphan reset: put the item back in its start state with a note. */
  reset(key: string, note: string): Promise<void>;
}

export interface PrCandidate {
  number: number;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  labels: string[];
  assignees: string[];
  /** Latest review per author. */
  reviews: Array<{ id: number; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | string; sha: string }>;
  /** GitHub mergeable_state: clean | unstable | behind | dirty | blocked | ... */
  mergeableState: string;
}

export interface MergeSource {
  name: string;
  mergeCandidates(): Promise<PrCandidate[]>;
  refresh(number: number): Promise<PrCandidate | undefined>;
  /** How a PR that left the open set left it — for the persisted merge view. */
  disposition(number: number): Promise<'open' | 'merged' | 'closed'>;
  /** "owner/name" for the persisted merge view. */
  forgeRepo(): string;
  updateBranch(number: number): Promise<void>;
  merge(number: number, method: string): Promise<void>;
  comment(number: number, text: string): Promise<void>;
  addLabel(number: number, label: string): Promise<void>;
  /** Lobstah repo key for rebase chores against this forge repo. */
  repoKey(): string;
}

export interface MergePolicy {
  enabled: boolean;
  method: string;
  approvers: string[];
  assigneeApproves: boolean;
  restrictedLabels: string[];
  scope: 'own' | 'all';
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  enabled: false,
  method: 'squash',
  approvers: [],
  assigneeApproves: true,
  restrictedLabels: [],
  scope: 'own',
};

export const MARKER = /\[lobstah:([0-9a-f-]{36})\]/;
export function marker(uuid: string): string {
  return `[lobstah:${uuid}]`;
}
