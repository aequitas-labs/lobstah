import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, lobstahHome } from '@lobstah/core';
import type { Verb } from '@lobstah/core';

export interface MapEntry {
  uuid: string;
  kind: 'issue' | 'review';
  createdAt: string;
  /** A review round opened only by held identity comments (the active-round guard). */
  heldOnly?: boolean;
  lastReported?: Verb;
  /** PR changes still report when the dispatch verb has not changed. */
  reportedPrs?: string;
  lastInboundAt?: string;
  recovered?: boolean;
  /** Issue dispatches started for this key; legacy entries count as one. */
  attempts?: number;
  /** A finalized failure was reported; the tracker may offer this issue again. */
  released?: boolean;
  /** One editable status comment, with the last successful update for throttling. */
  liveCommentId?: string;
  liveCommentAt?: string;
  liveCommentBody?: string;
  liveCommentFingerprint?: string;
  liveCommentVerb?: Verb;
  /** This source refused an edit; use transition comments for this item. */
  liveCommentUnavailable?: boolean;
}

/** A successor cannot advance until its predecessor has merged into the default branch. */
export interface StackAdvance {
  parent: number;
  from: string;
  updateHead?: string;
}

/** An accepted native merge remains observable across daemon restarts. */
export interface PendingStackMerge {
  number: number;
  uuid?: string;
  enqueued?: boolean;
  members: number[];
}

interface StateFile {
  map: Record<string, MapEntry>;
  consumedApprovals: Record<string, string>;
  requestedReviews: Record<string, string>;
  stackHolds?: Record<string, string>;
  stackAdvances?: Record<string, StackAdvance>;
  stackMerges?: Record<string, PendingStackMerge>;
  rebases: Record<string, { uuid: string; failed?: boolean }>;
}

/**
 * Pickup's own state: the item-to-UUID mapping the loops correlate through,
 * the merge loop's PR-to-chore table, and consumed approvals. Load-bearing,
 * so written atomically — and reconstructible from the tracker trail, so a
 * missing entry is `unknown` and triggers a rebuild, never a reset.
 */
export class PickupState {
  private file: string;
  private data: StateFile;

  constructor(dir = path.join(lobstahHome(), 'pickup')) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    this.data = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as StateFile)
      : { map: {}, consumedApprovals: {}, requestedReviews: {}, rebases: {} };
    this.data.map ??= {};
    this.data.consumedApprovals ??= {};
    this.data.requestedReviews ??= {};
    this.data.rebases ??= {};
  }

  private save(): void {
    const tmp = uniqueTempPath(this.file);
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key: string): MapEntry | undefined {
    return this.data.map[key];
  }
  entries(): Array<[string, MapEntry]> {
    return Object.entries(this.data.map);
  }
  set(key: string, entry: MapEntry): void {
    this.data.map[key] = entry;
    this.save();
  }
  update(key: string, patch: Partial<MapEntry>): void {
    const cur = this.data.map[key];
    if (!cur) return;
    this.data.map[key] = { ...cur, ...patch };
    this.save();
  }

  releaseIssue(key: string): void {
    const entry = this.get(key);
    if (entry?.kind !== 'issue' || entry.lastReported !== 'failed') return;
    this.update(key, { released: true, attempts: entry.attempts ?? 1 });
  }

  approvalConsumed(dedupKey: string): boolean {
    return dedupKey in this.data.consumedApprovals;
  }
  consumeApproval(dedupKey: string): void {
    this.data.consumedApprovals[dedupKey] = new Date().toISOString();
    this.save();
  }

  reviewRequested(prKey: string, headSha: string): boolean {
    return this.data.requestedReviews[prKey] === headSha;
  }
  markReviewRequested(prKey: string, headSha: string): void {
    this.data.requestedReviews[prKey] = headSha;
    this.save();
  }

  /** Announce a held stack once per reason and head. */
  newStackHold(key: string, reason: string): boolean {
    if (this.data.stackHolds?.[key] === reason) return false;
    (this.data.stackHolds ??= {})[key] = reason; this.save(); return true;
  }
  /** Pending native requests must remain visible even when their PRs leave the open list. */
  stackMergeEntries(source: string): Array<[string, PendingStackMerge]> {
    return Object.entries(this.data.stackMerges ?? {}).filter(([key]) => key.startsWith(source + ':stack:'));
  }

  /** Read a persisted bottom-up transition. */
  stackAdvance(key: string): StackAdvance | undefined { return this.data.stackAdvances?.[key]; }
  /** Save before merging a predecessor so a restart cannot lose the successor. */
  setStackAdvance(key: string, step: StackAdvance): void {
    (this.data.stackAdvances ??= {})[key] = step; this.save();
  }
  /** Retire a transition only after its successor is ready on the default branch. */
  clearStackAdvance(key: string): void { delete this.data.stackAdvances?.[key]; this.save(); }
  /** Native merge requests still need a result or eventual merge observation. */
  stackMerge(key: string): PendingStackMerge | undefined { return this.data.stackMerges?.[key]; }
  /** Retain GitHub's asynchronous request id. */
  setStackMerge(key: string, pending: PendingStackMerge): void { (this.data.stackMerges ??= {})[key] = pending; this.save(); }
  /** Remove a completed native request. */
  clearStackMerge(key: string): void { delete this.data.stackMerges?.[key]; this.save(); }

  rebase(prKey: string): { uuid: string; failed?: boolean } | undefined {
    return this.data.rebases[prKey];
  }
  setRebase(prKey: string, uuid: string): void {
    this.data.rebases[prKey] = { uuid };
    this.save();
  }
  failRebase(prKey: string): void {
    const cur = this.data.rebases[prKey];
    if (cur) {
      cur.failed = true;
      this.save();
    }
  }
  clearRebase(prKey: string): void {
    delete this.data.rebases[prKey];
    this.save();
  }
}
