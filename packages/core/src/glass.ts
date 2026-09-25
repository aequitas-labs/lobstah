import type { AttentionKind } from './config.js';
import type { HelmRegistration } from './helm.js';
import type { Notice } from './notices.js';
import type { PrBadge, PrEvidence } from './pr.js';
import type { TrapRegistration } from './soak.js';
import type { Attachment, Evidence, Lane, StatusEntry, Verb } from './types.js';
import type { Watch } from './watch.js';

/**
 * The spyglass's data contract: the JSON `lobstah glass` serves at /data.
 * The server builds it (apps/cli/src/glass.ts, buildGlassSnapshot) and every
 * client renderer (apps/cli/glass/src) reads it, so a renamed field fails
 * typecheck on both sides. Types only — nothing here runs.
 */

/** tend's attention kinds: the configurable ones plus `watch`. */
export type TendAttentionKind = AttentionKind | 'watch';

/** One attention item exactly as `man tend` derives it. */
export interface TendAttention {
  kind: TendAttentionKind;
  /** Stable item key: `<lane>:<id>` for question/landed, the PR key for pr:*, `watch:<key>` for watch. */
  key: string;
  /** Hash of the fields the kind stands on — an ack holds only while it matches (acks.ts). */
  stateHash: string;
  /** A human acknowledged this state (display-only: the pet and glass lobs skip it; nothing else does). */
  acked?: { at: string; by: string };
  id: string;
  lane: Lane;
  /** The status verb for question/landed, `watch`, or the pr:* kind itself. */
  verb: string;
  ageSecs: number;
  at?: string;
  /** When this condition began standing; stable across subsequent observations. */
  standingSince?: string;
  note?: string;
  repo?: string;
  /** pr:* kinds: the evidence fields the kind derives from. */
  prUrl?: string;
  number?: number;
  state?: string;
  draft?: boolean;
  reviewDecision?: string;
  /** GitHub's merge state as observed (pr:conflict stands on DIRTY; pr:ready needs a mergeable one). */
  mergeStateStatus?: string;
  headSha?: string;
  checks?: PrEvidence['checks'];
  review?: PrEvidence['review'];
}

/** A catch whose last verb is done or failed (tend's landedCatches). */
export interface LandedCatch {
  key: string;
  id: string;
  lane: Lane;
  verb: 'done' | 'failed';
  at: string;
  note?: string;
  repo?: string;
  prUrl?: string;
  /** Landed after its grounds' reported-through cursor (or the grounds has none). */
  unreported: boolean;
}

/** Gate verdict for one open PR, as of the last merge-loop tick. */
export interface MergeViewPr {
  number: number;
  url: string;
  headRef: string;
  headSha: string;
  mergeableState: string;
  /** waiting-approval | behind-updated | conflict-chore:<uuid> | rebase-failed | blocked | draft | merged */
  gate: string;
  /** Dispatch UUID when the branch is lobstah-made (lobstah/<uuid>). */
  uuid?: string;
}

/**
 * The merge loop's observation of the forge, persisted per tick so a status
 * view (`lobstah man tend`, a dashboard) can report PR state from disk — at
 * most one poll tick stale — without its own forge calls. Observational, not
 * load-bearing: deleting it loses nothing but history.
 */
export interface MergeView {
  updatedAt: string;
  repo: string;
  open: MergeViewPr[];
  /** PRs that left the open set, with how they left. Pruned after 48h. */
  recent: Array<{ number: number; url: string; disposition: 'merged' | 'closed'; at: string }>;
}

export interface GlassPrWatch {
  key: string;
  /** man or dispatch:<uuid> — shown in the PR modal. */
  owner?: string;
  cursor: string;
  lastCheckedAt?: string;
  lastError?: string;
}

/** One PR row: records first, evidence for a PR with no record yet (glass-prs.ts). */
export interface GlassPr {
  key: string;
  url: string;
  number: number;
  repo: string;
  forgeRepo: string;
  title?: string;
  state: string;
  draft: boolean;
  checks: PrEvidence['checks'];
  review: PrEvidence['review'];
  reviewDecision: string;
  mergeStateStatus: string;
  baseRefName?: string;
  headRefName?: string;
  observedAt: string;
  updatedAt?: string;
  mergedAt?: string;
  closedAt?: string;
  badge: PrBadge;
  stackId: string;
  floor: string;
  position: number;
  nextMergeable: boolean;
  blockedBy?: number;
  dispatchIds: string[];
  gate?: string;
  watch?: GlassPrWatch;
}

export interface GlassStack {
  id: string;
  floor: string;
  repo: string;
  numbers: number[];
  open: boolean;
  nextNumber?: number;
  behind: number;
}

export interface GlassDispatch {
  id: string;
  lane: Lane;
  bucket: 'queued' | 'active' | 'done';
  repo: string;
  for?: string;
  followUp?: string;
  brief: string;
  attachments: Attachment[];
  messageAttachments: Attachment[];
  verb: Verb | 'unknown';
  note?: string;
  verbAt?: string;
  claimedBy?: string;
  log: StatusEntry[];
  inbox: string[];
  evidence?: Evidence;
  transcript?: string;
  /** Newest first: queue/active/done mtime. */
  sort: number;
  /** The evidence badge (prBadge) and when the PR was observed. */
  prBadge?: PrBadge & { observedAt: string };
  /** The merge view's gate verdict, where pick has one. */
  prGate?: string;
}

export interface GlassHelm extends HelmRegistration {
  /** The session id's first eight characters. */
  session: string;
  /** helmLabel(): who mans the helm. */
  man: string;
  transcript?: string;
}

/** A trap's mail, pending or delivered. */
export interface GlassMessage {
  file: string;
  state: 'pending' | 'delivered';
  from: string;
  at: string;
  text: string;
  attachments?: Attachment[];
}

/** A trap: live (a registration) or historical (only receipts, mail, and notices survive). */
export interface GlassTrap extends Partial<Omit<TrapRegistration, 'trapId'>> {
  trapId: string;
  live: boolean;
  messages: GlassMessage[];
  /** This trap's notices, newest first. */
  notices: Notice[];
  catches: GlassDispatch[];
}

/** The /data payload: one disk pass, everything the page renders. */
export interface GlassSnapshot {
  now: string;
  version: string;
  repoUrl: string;
  daemon?: { version?: string; heartbeat?: string };
  helms: GlassHelm[];
  traps: GlassTrap[];
  /** Newest first. */
  notices: Notice[];
  watches: Watch[];
  dispatches: GlassDispatch[];
  prs: GlassPr[];
  stacks: GlassStack[];
  attention: TendAttention[];
  landed: LandedCatch[];
  attentionKinds: string[];
  /** A config error, surfaced on the page instead of failing /data. */
  attentionError?: string;
  mergeView?: MergeView;
}
