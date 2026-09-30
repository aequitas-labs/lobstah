import type { AttentionKind } from './config.js';
import type { HelmRegistration } from './helm.js';
import type { Notice } from './notices.js';
import type { PrBadge, PrEvidence } from './pr.js';
import type { TrapRegistration } from './soak.js';
import type { Attachment, Evidence, Lane, StatusEntry, Verb } from './types.js';
import type { WaitingView } from './status.js';
import type { Watch } from './watch.js';
import type { ActivityView } from './activity.js';

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
  /**
   * question: held on the helm's turn (question-hold.ts). `man tend` lists it;
   * the pet, the glass, and notifyCommand do not, until the helm ends a turn
   * without answering it.
   */
  held?: boolean;
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
  /** waiting-approval | stale-approval | behind-updated | conflict-chore:<uuid> | rebase-failed | blocked | draft | merged */
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
  /** Last check against the forge. Shown, never sorted on. */
  observedAt: string;
  /** From the PR record; the order key (core prs.ts prNewestFirst). */
  firstSeenAt?: string;
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
  /** A PR repair that is due but waits: who holds it and why. */
  repairWait?: { heldBy: string; reason: string; until?: string };
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
  verb: Verb | 'unknown' | 'queued';
  /** A budget stop: work is saved for continuation, distinct from a worker failure. */
  outOfTimeWorkSaved?: boolean;
  note?: string;
  verbAt?: string;
  /** What the worker is doing now, from its event stream or its post-tool hook. Stale past wedgeThresholdSecs. */
  activity?: ActivityView;
  /** What a paused (or questioning) worker waits on outside lobstah (`report --waiting-on`). */
  waiting?: WaitingView;
  claimedBy?: string;
  log: StatusEntry[];
  inbox: string[];
  /** A send to it still waiting on the worker's next note. */
  awaitingReply?: { sentAt: string; from: string; line: string };
  evidence?: Evidence;
  /** The checkout it ran in (the origin's, for a follow-up that reused it); `(removed)` once culled. */
  worktree?: string;
  /** The dispatch whose worktree it reused. */
  worktreeOf?: string;
  /** Why releaseOnMerge kept its worktree after the PR merged. */
  worktreeKept?: string;
  elapsed?: string;
  attempt?: number;
  branch?: string;
  lastCommit?: string;
  aheadTrunk?: string;
  draftPr?: string;
  updated?: string;
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

/**
 * A filed report (reports.ts), without its markdown: the page fetches the
 * page from /report/<key>/md when a modal opens, and its images from
 * /report/<key>/files/<name>.
 */
export interface GlassReport {
  key: string;
  title: string;
  /** The trap name, `headless`, or `helm`. */
  author: string;
  filedAt: string;
  stateHash: string;
  /** A human acked this filing (`lobstah attention ack <key>`). */
  acked?: { at: string; by: string };
  dispatch?: string;
  lane?: Lane;
  /** The trap name, when a trap filed it. */
  trap?: string;
  grounds?: string;
  repo?: string;
  bytes: number;
  attachments: Attachment[];
  /** Attached basename → stored name, where a name was already taken. */
  renamed?: Record<string, string>;
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
  label?: string;
  /** Signed on now (the registration exists), including when its beat is stale. */
  live: boolean;
  /** Parked and recently beating; false for a stale or never-parked registration. */
  listening?: boolean;
  messages: GlassMessage[];
  /** This trap's notices, newest first. */
  notices: Notice[];
  catches: GlassDispatch[];
}

/** A standing decision as the glass renders it: the record plus its detail page. */
export interface GlassDecision {
  key: string;
  title: string;
  /** The detail markdown; images it names by bare filename load from the decision's attachments. */
  detail: string;
  options: string[];
  attachments: Attachment[];
  dispatch?: string;
  lane?: Lane;
  repo?: string;
  askedBy: string;
  askedAt: string;
  stateHash: string;
}

/** What an answer from the glass may carry (the server checks the same limits). */
export interface GlassAnswerLimits {
  /** Per-file bytes (limits.attachmentMaxBytes). */
  maxBytes: number;
  maxFiles: number;
  textMax: number;
  /** Accepted file extensions. */
  extensions: string[];
}

/** The /data payload: one disk pass, everything the page renders. */
export interface GlassSnapshot {
  /** Per-server secret for the same-origin actions: focusing a trap and answering a decision. */
  focusToken?: string;
  /** Native window selection is available on this host. Session links may work elsewhere. */
  focusSupported?: boolean;
  now: string;
  version: string;
  repoUrl: string;
  daemon?: { version?: string; heartbeat?: string };
  /** Work slots. `parked` dispatches (last report `paused`) hold none. */
  slots?: { headless: number; limit: number; traps: number; parked?: number };
  helms: GlassHelm[];
  traps: GlassTrap[];
  /**
   * Trap id → name for every `wt:<id>` the snapshot shows: the live
   * registration's name, else the name registry's. An id with no known
   * name is absent; the page shows it as `wt:<id>`.
   */
  trapNames?: Record<string, string>;
  /** Newest first. */
  notices: Notice[];
  watches: Watch[];
  dispatches: GlassDispatch[];
  prs: GlassPr[];
  stacks: GlassStack[];
  attention: TendAttention[];
  landed: LandedCatch[];
  /** Every filed report, newest first. */
  reports: GlassReport[];
  attentionKinds: string[];
  /** A config error, surfaced on the page instead of failing /data. */
  attentionError?: string;
  mergeView?: MergeView;
  /** Standing decisions, newest first. The deck's cards join them to `decision` attention items by key. */
  decisions?: GlassDecision[];
  answerLimits?: GlassAnswerLimits;
}
