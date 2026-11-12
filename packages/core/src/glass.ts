import type { ReviewRoundState } from './reviews.js';
import type { RecentRun } from './run-history.js';
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
import type { TodoView } from './todos.js';
import type { RunCard, ScriptWarning } from './run-cards.js';
import type { HelmPassView } from './helm-pass.js';
import type { PermissionsProposal } from './decisions.js';
import type { ViewerDevice } from './viewer-device.js';

/**
 * The spyglass's data contract: the JSON `lobstah glass` serves at /data.
 * The server builds it (apps/cli/src/glass.ts, buildGlassSnapshot) and every
 * client renderer (apps/cli/glass/src) reads it, so a renamed field fails
 * typecheck on both sides. Types only — nothing here runs.
 */

/** tend's attention kinds: the configurable ones plus `watch`. */
export type TendAttentionKind = AttentionKind | 'watch' | 'dispatch-progress';

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
   * the pet, the glass, and [hooks.notify] do not, until the helm ends a turn
   * without answering it.
   */
  held?: boolean;
  /** Progress with no current human action: visible, but never walks. */
  quiet?: boolean;
  /** One item owns every member's attention, regardless of watch ownership. */
  /** A stack's short line for a small surface (the pet's bubble, a glass lob): title, count and state. */
  headline?: string;
  stack?: { title?: string; ready: number; total: number; allReady: boolean; members: Array<{ key: string; url: string; number: number; title?: string; note: string; kinds: TendAttentionKind[] }> };
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
  /** An item of a grounds on a wharf: that grounds and the wharf's name. Absent for local grounds. */
  grounds?: string;
  wharf?: string;
  /**
   * An item of a grounds on a wharf: the hosted glass at this item
   * (`<glass origin>/#job/<id>`), where a click on it goes. Absent for local
   * grounds (the local glass), and until the wharf has named its glass.
   */
  glass?: string;
  /**
   * Another mirror boat's item, read from the wharf (apps/cli/src/wharf-attention.ts):
   * that boat's id and name. Its key is `@<boat id>/<the boat's own key>`. Absent for this boat's own items.
   */
  boat?: { id: string; name: string };
  /** pr:* kinds: the evidence fields the kind derives from. */
  prUrl?: string;
  /** Click destination only: prUrl remains the canonical watch/ack identity. */
  reviewUrl?: string;
  /** Report/decision click route from [pet].open; PR clicks are independent. */
  petOpen?: 'tab' | 'app' | 'helm';
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
  /** Joined from the PR's record when tend builds its report. */
  title?: string;
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
  recent: Array<{ number: number; url: string; title?: string; disposition: 'merged' | 'closed'; at: string }>;
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
  /** The author's GitHub login as last observed, when known. */
  author?: string;
  /** The person's own PR: authored by the login gh signs in as, or opened by a dispatch and not known to be another author's. The PRs tab's Yours. */
  mine?: boolean;
  /** "Merge when green" stands on this PR: asked when, and the method it merges with. */
  mergeRequest?: { at: string; method: 'merge' | 'squash' | 'rebase' };
  /** How Merge when green would merge this open PR of yours: its repo's method. */
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export interface GlassStack {
  id: string;
  floor: string;
  repo: string;
  numbers: number[];
  open: boolean;
  nextNumber?: number;
  behind: number;
  /** What a stack of several PRs is about (core prStackTitle). Absent for a lone PR, whose row has its own title. */
  title?: string;
  /** Shared stack readiness, absent for a lone PR or an incomplete chain. `state` leaves out what the heading says. */
  readiness?: { id: string; url: string; ready: number; total: number; allReady: boolean; text: string; state: string };
  /** "Merge stack when green", while it stands: how it merges, and whether GitHub has taken the merge (it can't be cancelled then). */
  mergeRequest?: { at: string; method: 'merge' | 'squash' | 'rebase'; merging?: boolean };
  /** Whether every PR in it is the person's own or a dispatch's, so the glass may offer to merge the whole stack. */
  mine?: boolean;
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
  repo?: string;
  target?: import('./configured-trap-model.js').ConfiguredTrapTarget;
  for?: string;
  followUp?: string;
  /** The brief's first line. */
  title: string;
  verb: Verb | 'unknown' | 'queued' | 'limited';
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
  prList?: Array<{ url: string; number: number; title?: string; badge?: PrBadge; position?: number; size?: number }>;
  /**
   * The PR its card leads with: the work it is doing now (glass-prs.ts
   * dispatchPrHead), with how many of its PRs are open. Absent while it
   * builds a new PR after an earlier one ended.
   */
  prHead?: { url: string; number: number; badge?: PrBadge & { observedAt: string }; open: number; several: boolean };
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
/** A review item as the glass shows it (reviews.ts): the PR and its newest round. */
export interface GlassReview {
  key: string;
  url: string;
  /** The PR in the repo's review tool ([repos.<key>].reviewTool), where the staged draft is edited and sent. */
  reviewUrl: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  author: string;
  /** The configured repo key, when the PR is in one. */
  repoKey?: string;
  mode?: import('./reviews.js').ReviewMode;
  publish?: boolean;
  mutedAt?: string;
  postedReviewUrl?: string;
  requestedBy?: string;
  asker?: string;
  askerName?: string;
  askerAvatarUrl?: string;
  automatic?: boolean;
  stagedReviewUrl?: string;
  verdict?: import('./reviews.js').ReviewVerdict;
  blocking?: import('./reviews.js').BlockingFinding[];
  summary?: string;
  needsYou?: boolean;
  seenAt?: string;
  acknowledgedAt?: string;
  notification?: import('./reviews.js').ReviewNotification;
  requestedAt: string;
  state: ReviewRoundState;
  /** The newest round waits on the person (it is in the review attention kind's standing set). */
  stands: boolean;
  reason?: string;
  /** The head the round reviews, and the PR's head now. */
  headSha: string;
  prHeadSha: string;
  draftedAt?: string;
  postedAt?: string;
  by?: string;
  /** The draft is staged on the PR as the identity's pending review. */
  staged?: boolean;
  /** The newest round's review job, when one ran: the card names the trap that has it. */
  dispatch?: string;
}

export type { ChecklistItem, ChecklistProgress } from './checklist-types.js';

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
  /** Provider quota state takes precedence over a stale catch or heartbeat. */
  usageLimit?: import('./usage-limits.js').UsageLimitGroup;
  desktopThread?: boolean;
  /** The Claude Remote Control URL Claude emitted for this live session. It opens on any device the owner is signed in on. */
  liveLink?: string;
  /** Set when two processes hold this trap's session: the live link is withheld. */
  sessionWriters?: number[];
  /** The command that joins this live trap's tmux pane, written for where this page's viewer is. */
  attachCommand?: string;
  trapId: string;
  label?: string;
  /** `label` after the trap's repo, for a card with no repo column. */
  repoLabel?: string;
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
  /** The boat this trap runs on, when it is not this machine (a wharf's trap). */
  boat?: string;
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
  /** Closed cards are available through their deep link, without answer controls. */
  readOnly?: boolean;
  appStart?: import('./desktop-start-link.js').DesktopAppStart;
  key: string;
  title: string;
  /** The detail markdown; images it names by bare filename load from the decision's attachments. */
  detail: string;
  options: string[];
  /** A short note shown on an option, by label. */
  optionNotes?: Record<string, string>;
  /** Permission cards accept only an explicit option, with no free-form inputs. */
  permission?: boolean;
  permissionsProposal?: PermissionsProposal;
  /** A run card: the script the glass runs once Chris confirms it. */
  run?: GlassRunCard;
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

/** A run card as the glass shows it: the stored script in full, what runs it, and what a reader could miss in it. */
export interface GlassRunCard extends RunCard {
  /** On the hosted glass: the boat the card runs on, set when the boats' glasses merge. */
  boat?: string;
  /** The boat's public key for sealing secret inputs (P-256, SPKI DER, base64url): the page seals to it on the hosted glass. */
  sealKey?: string;
  /** Durable run metadata, with output fetched separately by the local person view. */
  latest?: import('./run-history.js').RunAttempt;
  /** The stored script's text, whole. */
  script: string;
  /** Characters a reader could miss or misread, by line and column. */
  warnings: ScriptWarning[];
  /** The stored copy no longer hashes to the card's value, or is gone: it never runs. */
  altered?: boolean;
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

/**
 * What the server can tell about a page's viewer, from the request's Host and User-Agent.
 * This decides what the page offers. It authorizes nothing: every action still
 * checks Host, Origin and the page token.
 */
export interface GlassViewer {
  /** The request used this glass's own address: this machine, or a forward that keeps that address. */
  onMachine: boolean;
  /** Native window selection can run for this viewer. Session links may work without it. */
  windowFocus: boolean;
  /** This machine's short name, for saying where its traps run. */
  machine: string;
  /** The device asking. Commands and session links are offered only where they can work. */
  device: ViewerDevice;
}

/** The /data payload: one disk pass, everything the page renders. */
export interface GlassHeavyTicket {
  state: 'running' | 'over' | 'waiting';
  command: string;
  trap?: string;
  dispatch?: string;
  /** When it started running, or joined the line. */
  since?: string;
  /** Place among the waiters, from 1. */
  position?: number;
}

export interface GlassHeavy {
  slots: number;
  running: number;
  waiting: number;
  tickets: GlassHeavyTicket[];
}

export interface GlassSnapshot {
  /** One banner per provider account and limit, shared by desktop and phone. */
  usageLimits?: import('./usage-limits.js').UsageLimitGroup[];
  helmPasses?: HelmPassView[];
  goals?: Array<{ grounds: string; date: string; lines: string[] }>;
  backends?: Array<{ grounds: string; kind: 'local' | 'wharf'; wharf?: string; url?: string; unavailable?: string }>;
  /** Per-server secret for the same-origin actions, sent only to this machine's own glass address. */
  focusToken?: string;
  /**
   * In a mirrored snapshot only: the loopback port this machine's glass
   * listens on, and the id its focus probe answers with. The hosted glass
   * probes it to learn whether it runs on this boat, where ↗ Open can raise
   * a window.
   */
  mirror?: { port: number; id: string };
  /** What the server can tell about who asked for this page. */
  viewer?: GlassViewer;
  /** The passkeys registered to confirm run cards' Run (count only; never a key), and how many phones paired one for the hosted glass. */
  runPasskeys?: { count: number; newestAt?: string; hosted?: number };
  /** Configured repo keys, for the New trap form. */
  repoKeys?: string[];
  /** A helm is signed on and beating: a trap request will be answered. */
  helmOn?: boolean;
  now: string;
  version: string;
  repoUrl: string;
  /** Forge owner/repo (lowercase) → review preset/template; presentation only. */
  reviewTools?: Record<string, string>;
  daemon?: { version?: string; heartbeat?: string };
  /** Work slots. `parked` dispatches (last report `paused`) hold none. */
  slots?: { headless: number; limit: number; traps: number; parked?: number };
  /** The machine's heavy line. */
  heavy?: GlassHeavy;
  helms: GlassHelm[];
  traps: GlassTrap[];
  configuredTraps?: import('./configured-trap-views.js').ConfiguredTrapView[];
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
  /** Review requests ([reviews]); absent on a hosted grounds. */
  reviews?: GlassReview[];
  sessionGrants?: import('./grants.js').Grant[];
  /** Every other grant in force: intent grants, commands and files. */
  standingGrants?: import('./grants.js').Grant[];
  reviewSetup?: { enabled: boolean; mode: import('./reviews.js').ReviewMode; publish?: boolean; autoPostApprove?: import('./reviews.js').ReviewAutoPost; autoPostRequestChanges?: import('./reviews.js').ReviewAutoPost; perRepo?: Record<string, { mode: import('./reviews.js').ReviewMode; publish: boolean; autoPostApprove: import('./reviews.js').ReviewAutoPost; autoPostRequestChanges: import('./reviews.js').ReviewAutoPost; overridden: boolean }>; identity?: string; running: boolean };
  /** The helms' open to-dos, every grounds; the deck lists them. */
  todos?: TodoView[];
  /** A short note when to-dos sit past `[helm].todoStaleDays`. */
  todoNote?: string;
  attentionKinds: string[];
  /** A config error, surfaced on the page instead of failing /data. */
  attentionError?: string;
  mergeView?: MergeView;
  /** Standing decisions, newest first. The deck's cards join them to `decision` attention items by key. */
  decisions?: GlassDecision[];
  /** Finished runs whose cards have left the glass, newest first: the deck's Recent runs. */
  recentRuns?: RecentRun[];
  answerLimits?: GlassAnswerLimits;
}

/** A snapshot with every dispatch whole: what the server reads from disk before /data slims it (glass-poll.ts). */
export type GlassFullSnapshot = Omit<GlassSnapshot, 'dispatches'> & { dispatches: GlassDispatch[] };

/** Where a value came from: config.toml, or lobstah's default. */
export type SettingSource = 'config' | 'default';

/** One setting as the page shows it. `value` is already masked. */
export interface SettingRow {
  key: string;
  value: string;
  source: SettingSource;
}

/** A named group of settings. */
export interface SettingsSection {
  title: string;
  rows: SettingRow[];
}

/** One repo's settings, with its traps in use beside its cap. */
export interface SettingsRepo {
  key: string;
  /** In use against the cap; `idle` stowed and ghosted traps hold no slot; `held` ghosted ones still have a session open. */
  traps: { used: number; limit?: number; idle?: number; held?: string[] };
  rows: SettingRow[];
}

/** One grounds and the repos it holds. */
export interface SettingsGrounds {
  name: string;
  repos: string[];
}

/** One installed part of lobstah and its version; a plugin that isn't installed is left out. */
export interface SettingsVersion {
  name: string;
  version: string;
  note?: string;
}

/** The body of `GET /data/settings`. */
export interface GlassSettings {
  /** The config file these values come from. */
  file: string;
  /** Why the config could not be loaded. Its sections are then empty. */
  error?: string;
  versions: { rows: SettingsVersion[]; match: boolean; text: string };
  grounds: SettingsGrounds[];
  repos: SettingsRepo[];
  sections: SettingsSection[];
}
