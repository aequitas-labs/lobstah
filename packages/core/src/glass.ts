import type { AttentionKind } from './config.js';
import type { HelmRegistration } from './helm.js';
import type { Notice } from './notices.js';
import type { PrBadge, PrEvidence } from './pr.js';
import type { TrapRegistration } from './soak.js';
import type { Attachment, Evidence, Lane, StatusEntry, Verb } from './types.js';
import type { WorkerMetadata } from './worker-metadata.js';
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
  /** decision and question: when the human first viewed it in the glass's decision modal. State only, never a wake. */
  viewedAt?: string;
  /**
   * question: held on the helm's turn (question-hold.ts). `man tend` lists it;
   * the pet, the glass, and notifyCommand do not, until the helm ends a turn
   * without answering it.
   */
  held?: boolean;
  /** Progress with no current human action: visible, but never walks. */
  quiet?: boolean;
  /** One item owns every member's attention, regardless of watch ownership. */
  stack?: { ready: number; total: number; allReady: boolean; members: Array<{ key: string; url: string; number: number; note: string; kinds: TendAttentionKind[] }> };
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
  isCrossRepository?: boolean;
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
  /** Shared stack readiness, absent for a lone PR or an incomplete chain. */
  readiness?: { id: string; url: string; ready: number; total: number; allReady: boolean; text: string };
}

/** The evidence fields a dispatch's row shows: where it went and its PRs. */
export interface GlassEvidenceSummary {
  deliveredTo?: string;
  prUrl?: string;
  prUrls?: string[];
  pr?: { url?: string };
}

/**
 * A dispatch as /data sends it: what its row, card, and deck entry show. The
 * brief, log, inbox, attachments, and full evidence are in its detail
 * (`/data/dispatch/<id>`), which the page fetches when its modal opens.
 */
export interface GlassDispatchSummary {
  /** Remote display identity is separate from the wharf's dispatch id. */
  backend?: { grounds: string; wharf: string; dispatch: string; unavailable?: string };
  worker?: WorkerMetadata;
  id: string;
  lane: Lane;
  bucket: 'queued' | 'active' | 'done';
  repo: string;
  for?: string;
  followUp?: string;
  /** The brief's first line. */
  title: string;
  verb: Verb | 'unknown' | 'queued';
  /** A budget stop: work is saved for continuation, distinct from a worker failure. */
  outOfTimeWorkSaved?: boolean;
  /** The last note; in /data, cut to NOTE_MAX characters. */
  note?: string;
  /** /data cut the note; the detail has all of it. */
  noteCut?: boolean;
  verbAt?: string;
  /** What the worker is doing now, from its event stream or its post-tool hook. Stale past wedgeThresholdSecs. */
  activity?: ActivityView;
  /** What a paused (or questioning) worker waits on outside lobstah (`report --waiting-on`). */
  waiting?: WaitingView;
  claimedBy?: string;
  /** A send to it still waiting on the worker's next note. */
  awaitingReply?: { sentAt: string; from: string; line: string };
  evidence?: GlassEvidenceSummary;
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
  /** Every PR of a dispatch with more than one, in stack order, each with its badge once observed. */
  prList?: Array<{ url: string; number: number; badge?: PrBadge }>;
}

/** A dispatch with everything: its summary plus the fields its modal shows. */
export interface GlassDispatch extends GlassDispatchSummary {
  brief: string;
  attachments: Attachment[];
  messageAttachments: Attachment[];
  log: StatusEntry[];
  inbox: string[];
  evidence?: Evidence;
}

/** What /data leaves out as history: the `/data/older` kinds. */
export type GlassOlderKind = 'dispatches' | 'notices' | 'prs';

/** One page of history from `/data/older?kind=<kind>&offset=<n>`, newest first. A PR page carries its PRs' stacks. */
export type GlassOlderPage =
  | { kind: 'dispatches'; offset: number; total: number; items: GlassDispatchSummary[] }
  | { kind: 'notices'; offset: number; total: number; items: Notice[] }
  | { kind: 'prs'; offset: number; total: number; items: GlassPr[]; stacks: GlassStack[] };

/**
 * The fields that tick on every poll: the server time and heartbeats. The
 * ETag leaves them out, and every /data answer, a 304 too, carries them in
 * the `x-lobstah-beats` header.
 */
export interface GlassBeats {
  now: string;
  daemon?: string;
  /** Helm grounds → heartbeatAt. */
  helms: Record<string, string>;
  /** Trap id → its beat fields. */
  traps: Record<string, { heartbeatAt?: string; parkedAt?: string }>;
}

export interface GlassHelm extends HelmRegistration {
  desktopThread?: boolean;
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
  desktopThread?: boolean;
  trapId: string;
  label?: string;
  /** Signed on now (the registration exists), including when its beat is stale. */
  live: boolean;
  /** Parked and recently beating; false for a stale or never-parked registration. */
  listening?: boolean;
  /** A reserved trap no session has signed on as yet (`man throw`); `live` is false. */
  starting?: {
    reservedAt: string;
    deadline: string;
    failedAt?: string;
    reason?: string;
    /** The start commands with the ticket: only in a snapshot served to this machine's own glass page. */
    commands?: Array<{ harness: 'claude' | 'codex'; command: string }>;
  };
  /** A trap asked for from the glass that no helm has reserved yet; `trapId` is the request id. */
  requested?: { at: string };
  messages: GlassMessage[];
  /** This trap's notices, newest first. */
  notices: Notice[];
  /** The ids of this trap's catches, in `dispatches` order; the page reads each from `dispatches`. */
  catches: string[];
  /** This trap's catches (dispatches it finished done), all time. Unlike `catches`, survives cull. */
  totalCatches?: number;
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
  /** When the human first viewed it in the decision modal; absent = unread. */
  viewedAt?: string;
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
  backends?: Array<{ grounds: string; kind: 'local' | 'wharf'; wharf?: string; url?: string; unavailable?: string }>;
  /** Per-server secret for the same-origin actions: focusing a trap and answering a decision. */
  focusToken?: string;
  /** Native window selection is available on this host. Session links may work elsewhere. */
  focusSupported?: boolean;
  /** Configured repo keys, for the New trap form. */
  repoKeys?: string[];
  /** A helm is signed on and beating: a trap request will be answered. */
  helmOn?: boolean;
  now: string;
  version: string;
  repoUrl: string;
  daemon?: { version?: string; heartbeat?: string };
  /** Work slots. `parked` dispatches (last report `paused`) hold none. */
  slots?: { headless: number; limit: number; traps: number; parked?: number };
  helms: GlassHelm[];
  traps: GlassTrap[];
  /** Catches (dispatches finished done): today, on the server's local day, and all time. */
  stats?: { catchesToday: number; totalCatches: number };
  /**
   * Trap id → name for every `wt:<id>` the snapshot shows: the live
   * registration's name, else the name registry's. An id with no known
   * name is absent; the page shows it as `wt:<id>`.
   */
  trapNames?: Record<string, string>;
  /** Newest first: the last day's, at least the newest few. */
  notices: Notice[];
  /** How many records of each kind /data left out; `/data/older` pages them in. */
  older?: Record<GlassOlderKind, number>;
  watches: Watch[];
  /**
   * Queued and active dispatches, and finished ones from the last day (at
   * least the newest few). Older ones page in from `/data/older`.
   */
  dispatches: GlassDispatchSummary[];
  /** Open PRs, and merged or closed ones from the last day (at least the newest few). */
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

/** A snapshot with every dispatch whole: what the server reads from disk before /data slims it (glass-poll.ts). */
export type GlassFullSnapshot = Omit<GlassSnapshot, 'dispatches'> & { dispatches: GlassDispatch[] };
