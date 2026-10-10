import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  workerLabel,
  questionViewedAt,
  activeIds,
  questionHeld,
  waitingText,
  waitingView,
  activityLine,
  activityView,
  readActivity,
  answeredAt,
  awaitingReply,
  ageLabel,
  displayState,
  displayGrounds,
  executorPath,
  laneDirs,
  lastEventAt,
  helmLabel,
  listHelms,
  listNotices,
  listTraps,
  listReservations,
  trapLabel,
  trapNamer,
  nameTrapsIn,
  listWatches,
  watchErrorCell,
  loadConfig,
  parsePrRef,
  pendingIds,
  prBadge,
  prNewestFirst,
  prStandingKinds,
  queuedDescriptor,
  readEvidence,
  readPr,
  readPrs,
  readSessionClaim,
  readTrap,
  readStatusLog,
  queuedAt,
  readWatch,
  readWatchEvents,
  toonKV,
  toonTable,
  holdReason,
  readHold,
  slotUsage,
  parkedDispatches,
  isFinished,
  derivePrStacks,
  prStackTrunk,
  readStackEpochs,
  stackReadyEnabled,
  stackStateHash,
  identifyPrStacks,
  humanGatesFor,
  matchesGate,
  repoKey as forgeRepoKey,
  poolViews,
  poolWaits,
} from '@lobstah/core';
import type {
  AttentionKind,
  ActivityView,
  WaitingView,
  DiskHold,
  Config,
  Descriptor,
  LandedCatch,
  Lane,
  MergeView,
  PrEvidence,
  TendAttention,
  TendAttentionKind,
  PoolView,
} from '@lobstah/core';
import { readMergeView, readPickupMap } from '@lobstah/pick';
import { readCursor, reportedThroughMs } from './reported.js';
import { currentAck, prStateHash, statusStateHash } from './acks.js';
import { reportAttention } from './report-file.js';
import { decisionAttention, hideFramedQuestions } from './decisions.js';
import { worktreeView } from './worktree-view.js';
import { backendViews, hostedAttention } from './hosted-view.js';
import { livenessView } from './liveness-view.js';
import { deriveGlassPrs } from './glass-prs.js';
import { liveRepairer, repairChores, waitingRepairs } from './pr-repair.js';
import type { RepairChore } from './pr-repair.js';
import type { GlassStack } from './glass-prs.js';

/** Heartbeats are written every daemon tick; well past that means down. */
const HEARTBEAT_STALE_MS = 90_000;
/** A queued item this old with capacity free means claiming is broken. */
const CLAIM_STALE_MS = 120_000;
const DAY_MS = 24 * 3600_000;

export interface TendDispatch {
  id: string;
  lane: Lane;
  bucket: 'queued' | 'active' | 'done';
  state: string;
  /** Budget exhaustion is work saved for continuation, not a worker error. */
  outOfTimeWorkSaved?: boolean;
  note?: string;
  at?: string;
  /** A needs-decision / blocked the helm (or anyone) has answered but the worker hasn't acted on yet. */
  answeredAt?: string;
  prUrl?: string;
  /** Every PR of a dispatch that has more than one, `prUrl` first. */
  prUrls?: string[];
  /** PR state as last observed by the chain's pr: watch. */
  pr?: PrEvidence;
  /** The checkout it ran in (the origin's, for a follow-up that reused it). */
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
  /** What the worker is doing now (active dispatches only). Stale past wedgeThresholdSecs. */
  activity?: ActivityView;
  /** What a paused (or questioning) worker waits on outside lobstah (`report --waiting-on`). */
  waiting?: WaitingView;
  /** A send to it still waiting on the worker's next note. */
  awaitingReply?: { sentAt: string; from: string; line: string };
}

export interface TendStory {
  /** Tracker key ("linear:BAS-12", "gh:owner/repo#3") or "(direct)". */
  key: string;
  dispatches: TendDispatch[];
  prUrl?: string;
  /** Every PR of the chain when it has more than one, each `<state> <url>` when observed. */
  prs?: string[];
  /** Short PR state (prBadge) from evidence, when the chain's pr: watch observed it. */
  prState?: string;
  /** Merge-gate verdict from the pick snapshot, when one matches. */
  gate?: string;
  /** External source watched by a dispatch in this chain (e.g. a ume review). */
  watch?: string;
}

export interface TendWatch {
  key: string;
  owner: string;
  cursor: string;
  pendingEvents: number;
  /** Set when the watch is held (fork cap, `watch hold`, a cancelled repair); `lobstah watch release` ends it. */
  heldAt?: string;
  /** Why the watch is held. */
  heldReason?: string;
  lastSummary?: string;
  lastAt?: string;
  error?: string;
}

export interface TendRepairWaiting {
  key: string;
  url: string;
  kind: string;
  heldBy: string;
  reason: string;
  /** A settle wait: the earliest time the repair can be queued. */
  until?: string;
}

export interface TendTrap {
  worker?: string;
  trap: string;
  name?: string;
  label: string;
  session: string;
  repo: string;
  worktree: string;
  claimed?: string;
  /** never | now (parked) | <age>s ago | starting (due in <n>s) | start failed */
  listening: string;
  /** Set for a reserved trap no session has signed on as yet. */
  state?: 'starting' | 'start-failed';
}

export interface TendAwaiting {
  id: string;
  for: string;
  ageMins: number;
}

export interface TendNotice {
  kind: string;
  ageMins: number;
  text: string;
  url?: string;
}

/**
 * One thing awaiting a human (docs/vocabulary.md, "Attention contract").
 * Each kind stands while its condition holds and clears on its own:
 * - `question`: the dispatch's last status is needs-decision / blocked.
 * - `landed`: the dispatch is done / failed after the grounds' reported-through cursor.
 * - `pr:draft`: evidence pr open and draft.
 * - `pr:review`: open, with unresolved review threads or changes requested.
 * - `pr:checks`: open, with failed checks on the observed head.
 * - `pr:conflict`: open, and GitHub reports it conflicting with its base (mergeStateStatus DIRTY).
 * - `pr:ready`: open, not draft, no pr:review standing, merge state mergeable (CLEAN / HAS_HOOKS /
 *   UNSTABLE), check results readable, and approved or all checks passed with none pending,
 *   continuously for readySettleSecs on the same head.
 * - `watch`: an unconsumed man-owned watch event — machinery, always on.
 * Only `question` and `watch` drive the verdict; the rest are things to look at.
 */
export type { TendAttention, TendAttentionKind } from '@lobstah/core';

export interface ChainMember {
  id: string;
  bucket: TendDispatch['bucket'];
}

/**
 * The on-the-hook rule, pure: a pr:review or pr:checks item is suppressed
 * while a worker owns the problem — a queued or active dispatch in the PR's
 * chain that is a pickup feedback round (pickup's own map records it as
 * kind `review`) or the pr: watch's fix continuation (the watch records it
 * as lastFollowUpId). Returns the owning dispatch id, or undefined. When
 * that dispatch finishes without clearing the condition, the item stands
 * again. Every other kind is never suppressed.
 */
export function onTheHook(
  kind: TendAttentionKind,
  chain: ChainMember[],
  owners: { reviewRounds: ReadonlySet<string>; watchFollowUp?: string },
): string | undefined {
  if (kind !== 'pr:review' && kind !== 'pr:checks') return undefined;
  return chain.find((m) => m.bucket !== 'done' && (owners.reviewRounds.has(m.id) || m.id === owners.watchFollowUp))?.id;
}

/** Which pr:* kinds a PR's evidence stands on right now. Pure. */
export const prKinds = prStandingKinds;

const PR_KIND_NOTE: Record<string, (pr: PrEvidence) => string> = {
  'pr:draft': (pr) => `#${pr.number} draft`,
  'pr:review': (pr) =>
    `#${pr.number} review: ${[
      pr.review?.unresolvedThreads ? `${pr.review.unresolvedThreads} unresolved` : '',
      pr.review?.changesRequested ? 'changes requested' : '',
    ]
      .filter(Boolean)
      .join(', ')}`,
  'pr:checks': (pr) => `#${pr.number} checks ${pr.checks.failed}/${pr.checks.total} failed`,
  'pr:conflict': (pr) => `#${pr.number} conflicts with ${pr.baseRefName ?? 'its base'}`,
  'pr:ready': (pr) => `#${pr.number} ready to merge`,
};

/** Hide a repairable problem only after a live repairer has claimed safe work. */
export function humanPrAttention(
  pr: PrEvidence,
  kind: TendAttentionKind,
  cfg: Config,
  watchAvailable = true,
  now = Date.now(),
): { show: boolean; reason?: string } {
  if (kind !== 'pr:conflict' && kind !== 'pr:checks' && kind !== 'pr:review') return { show: true };
  const repairableReview = kind === 'pr:review' && pr.review?.changesRequested === true;
  if (kind === 'pr:review' && !repairableReview) return { show: true }; // unresolved question for a person
  const enabled = cfg.watch.autoRepair && (kind !== 'pr:conflict' || cfg.watch.conflicts) && (kind !== 'pr:checks' || cfg.watch.checks);
  if (!enabled) return { show: true, reason: 'auto-repair is off' };
  const owned = 'dispatches' in pr && Array.isArray(pr.dispatches) && pr.dispatches.length > 0;
  if (!owned) return { show: true, reason: 'not owned by lobstah' };
  const matchingRepair =
    pr.repair?.headSha === pr.headSha &&
    pr.repair.kind === (kind === 'pr:review' ? 'review' : kind === 'pr:conflict' ? 'conflict' : 'checks');
  if (matchingRepair && (pr.repair!.status === 'blocked' || pr.repair!.status === 'gave-up'))
    return { show: true, reason: pr.repair!.reason };
  if (!watchAvailable) return { show: true, reason: 'no active PR watch' };
  if (!liveRepairer(now)) return { show: true, reason: 'no repairer is running' };
  // A check that had its round at this head and still fails needs a person.
  if (matchingRepair && pr.repair!.status === 'waiting' && pr.repair!.heldBy === 'repaired') return { show: true, reason: pr.repair!.reason };
  // A waiting repair needs no person: it is shown in the repairs-waiting table instead.
  if (matchingRepair && pr.repair!.status === 'waiting') return { show: false, reason: `repair waits: ${pr.repair!.reason ?? ''}` };
  if (!matchingRepair || pr.repair?.status !== 'repairing' || !pr.repair.dispatchId)
    return { show: true, reason: 'repair not yet claimed' };
  const queued = queuedDescriptor(pr.repair.dispatchId, 'work');
  const active = fs.existsSync(path.join(laneDirs('work').active, pr.repair.dispatchId));
  const last = readStatusLog(pr.repair.dispatchId, 'work').at(-1)?.verb;
  if ((!queued && !active) || last === 'done' || last === 'failed') return { show: true, reason: 'repair awaiting next observation' };
  if (queued?.for?.startsWith('wt:')) {
    const trap = readTrap(queued.for.slice(3));
    if (!trap || !!trap.claimed || !trap.firstParkedAt || now - Date.parse(trap.heartbeatAt) > cfg.soak.deferSecs * 1000) {
      return { show: true, reason: `trap ${trap ? trapLabel(trap) : queued.for} not listening` };
    }
  }
  return { show: false };
}

/** A dispatch and every follow-up descending from it (work lane), with buckets. */
function chainOf(root: string): ChainMember[] {
  const out: ChainMember[] = [];
  const seen = new Set<string>();
  const walk = (id: string, bucket: TendDispatch['bucket']) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, bucket });
    for (const f of followUps(id)) walk(f.id, f.bucket);
  };
  walk(root, bucketOf(root) ?? 'done');
  return out;
}

/** The grounds whose cursor covers a repo: the one listing it, else the implicit `fleet`. */
function groundsCursorFor(cfg: Config, repo: string | undefined): string {
  if (repo === undefined) return 'fleet';
  return Object.entries(cfg.grounds).find(([, g]) => g.repos.includes(repo))?.[0] ?? 'fleet';
}

/** Dispatch evidence `pr` objects, newest per PR url — the legacy source. */
function evidencePrs(): Array<{ id: string; lane: Lane; pr: PrEvidence }> {
  const newest = new Map<string, { id: string; lane: Lane; pr: PrEvidence }>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    let files: string[];
    try {
      files = fs.readdirSync(laneDirs(lane).state).filter((f) => f.endsWith('.evidence'));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -'.evidence'.length);
      const pr = readEvidence(id, lane).pr;
      if (!pr) continue;
      const prev = newest.get(pr.url);
      if (!prev || prev.pr.observedAt < pr.observedAt) newest.set(pr.url, { id, lane, pr });
    }
  }
  return [...newest.values()];
}

const dispatchLane = (id: string): Lane | undefined =>
  (['work', 'chore'] as Lane[]).find((l) => fs.existsSync(path.join(laneDirs(l).state, `${id}.status`)));

/**
 * Observed PRs — the pr: watch's observations, never a forge call. Read
 * order: PR records first (core prs.ts: every observation, man-owned or
 * dispatch-owned), then dispatch evidence for a PR with no record yet. A
 * record attaches to its newest dispatch still on disk; one with none (a
 * human's PR, or a culled chain) is keyed by the PR itself: no chain, so
 * nothing puts it on the hook.
 */
function observedPrs(records = readPrs(), legacy = evidencePrs()): Array<{ id: string; lane: Lane; pr: PrEvidence; dispatch: boolean }> {
  const out: Array<{ id: string; lane: Lane; pr: PrEvidence; dispatch: boolean }> = [];
  const seen = new Set<string>();
  for (const r of records) {
    seen.add(r.url);
    const owner = [...r.dispatches].reverse().find((id) => dispatchLane(id) !== undefined);
    out.push(
      owner ? { id: owner, lane: dispatchLane(owner)!, pr: r, dispatch: true } : { id: r.key, lane: 'work', pr: r, dispatch: false },
    );
  }
  for (const e of legacy) if (!seen.has(e.pr.url)) out.push({ ...e, dispatch: true });
  return out;
}

function prAttention(now: number, observed = observedPrs(), cfg = loadConfig()): TendAttention[] {
  const reviewRounds = new Set(
    Object.values(readPickupMap())
      .filter((e) => e.kind === 'review')
      .map((e) => e.uuid),
  );
  const out: TendAttention[] = [];
  const stacks = identifyPrStacks(derivePrStacks(observed.map((x) => x.pr), {
    trunk: (repo) => prStackTrunk(cfg, repo), readySettleSecs: cfg.readySettleSecs, now,
  }));
  const epochs = readStackEpochs();
  for (const { id, lane, pr, dispatch } of observed) {
    const kinds = prKinds(pr, { readySettleSecs: cfg.readySettleSecs, now });
    if (kinds.length === 0) continue;
    const ref = parsePrRef(pr.url);
    const prWatch = ref ? readWatch(ref.key) : undefined;
    const watchFollowUp = prWatch?.lastFollowUpId;
    const chain = dispatch ? chainOf(id) : [];
    for (const kind of kinds) {
      if (kind === 'pr:checks' && stacks.some((s) => s.members.some((p) => p.url === pr.url))) {
        const gates = ['Approval Gate', ...humanGatesFor(readPr(pr.url), ref ? forgeRepoKey(cfg, `${ref.owner}/${ref.repo}`) : undefined)];
        if (pr.failingChecks?.length === pr.checks.failed && pr.failingChecks.every((c) => matchesGate(c.name, gates))) continue;
      }
      const human = humanPrAttention(pr, kind, cfg, !!prWatch && !prWatch.done, now);
      if (!human.show) continue;
      const repairCannotAct =
        human.reason !== undefined && !['auto-repair is off', 'not owned by lobstah', 'no active PR watch'].includes(human.reason);
      if (!repairCannotAct && onTheHook(kind, chain, { reviewRounds, watchFollowUp })) continue;
      // Older dispatch evidence has no record; its observation is the best
      // available approximation until a PR record is written.
      const conditionSince = pr.standingSince?.[kind] ?? pr.observedAt;
      const standingSince = kind === 'pr:ready'
        ? new Date(Date.parse(conditionSince) + cfg.readySettleSecs * 1000).toISOString()
        : conditionSince;
      out.push({
        kind,
        key: ref?.key ?? pr.url,
        stateHash: prStateHash(pr),
        id,
        lane,
        verb: kind,
        ageSecs: Math.max(0, Math.round((now - Date.parse(standingSince)) / 1000)),
        at: standingSince,
        standingSince,
        note: `${PR_KIND_NOTE[kind]!(pr)}${human.reason ? ` — ${human.reason}` : ''}`,
        repo: dispatch ? repoOf(id, lane) : ref ? `${ref.owner}/${ref.repo}` : undefined,
        prUrl: pr.url,
        number: pr.number,
        state: pr.state,
        draft: pr.draft,
        reviewDecision: pr.reviewDecision,
        mergeStateStatus: pr.mergeStateStatus,
        headSha: pr.headSha,
        checks: pr.checks,
        ...(pr.review ? { review: pr.review } : {}),
      });
    }
  }
  for (const s of stacks) {
    const members = s.members.map((pr) => {
      const items = out.filter((a) => a.prUrl === pr.url);
      return { key: parsePrRef(pr.url)!.key, url: pr.url, number: pr.number,
        note: items.map((a) => a.note).join('; ') || `#${pr.number} ${prBadge(pr).text}`,
        kinds: items.map((a) => a.kind) };
    });
    // Member readiness lives only in the stack item. A member's own problem
    // (conflicts, checks, review, draft) keeps standing as its own pr:* item.
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.kind === 'pr:ready' && s.members.some((p) => p.url === out[i]!.prUrl)) out.splice(i, 1);
    const top = s.members.at(-1)!, source = observed.find((x) => x.pr.url === top.url)!;
    const at = epochs[s.id]?.at ?? s.members[0]!.observedAt;
    out.push({ kind: 'stack-ready', key: `stack:${s.id}`,
      stateHash: stackStateHash(s, epochs[s.id]?.epoch),
      id: source.id, lane: source.lane, verb: 'stack-ready', at, standingSince: at,
      ageSecs: Math.max(0, Math.round((now - Date.parse(at)) / 1000)), note: s.text,
      // Only an all-ready stack (every member past its settle window) walks;
      // a partly ready one is a quiet standing row in tend and the glass.
      quiet: !s.allReady || !!epochs[s.id]?.silent || !!s.legacy,
      stack: { ready: s.ready, total: members.length, allReady: s.allReady, members },
      repo: forgeRepoKey(cfg, s.repo), prUrl: top.url });
  }
  return out;
}

/**
 * The kind as a person reads it. The stack item keeps its `stack-ready` kind
 * (config and acks use it), but it is only "ready" when every member is.
 */
export function attentionKindLabel(a: Pick<TendAttention, 'kind' | 'stack'>): string {
  return a.kind === 'stack-ready' && a.stack && !a.stack.allReady ? 'stack-waiting' : a.kind;
}

/** Terminal catches the helm hasn't been reported yet: past its grounds' cursor. */
export function landedAttention(cfg: Config, now: number): TendAttention[] {
  const out: TendAttention[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of doneIds(lane)) {
      const last = readStatusLog(id, lane).at(-1);
      if (!last || (last.verb !== 'done' && last.verb !== 'failed')) continue;
      const at = Date.parse(last.at) || 0;
      const repo = repoOf(id, lane);
      if (at <= reportedThroughMs(groundsCursorFor(cfg, repo), now) || at > now) continue;
      const ev = readEvidence(id, lane);
      out.push({
        kind: 'landed',
        key: `${lane}:${id}`,
        stateHash: statusStateHash(last.verb, last.at),
        id,
        lane,
        verb: last.verb,
        ageSecs: Math.max(0, Math.round((now - at) / 1000)),
        at: last.at,
        standingSince: last.at,
        note: last.note,
        repo,
        ...(ev.prUrl ? { prUrl: ev.prUrl } : {}),
      });
    }
  }
  return out.sort((a, b) => b.ageSecs - a.ageSecs);
}

/** One terminal catch for the glass's On deck "Landed" section. */
export type { LandedCatch } from '@lobstah/core';

/**
 * Every catch whose last verb is `done` or `failed`, newest first, each
 * marked against its grounds' reported-through cursor. Unlike
 * `landedAttention` this does not drop reported catches: the glass shows a
 * rolling window and only badges what the helm has not acknowledged.
 */
export function landedCatches(cfg: Config): LandedCatch[] {
  const out: LandedCatch[] = [];
  const cursors = new Map<string, number>();
  const cursorMs = (name: string): number => {
    if (!cursors.has(name)) cursors.set(name, Date.parse(readCursor(name) ?? '') || 0);
    return cursors.get(name)!;
  };
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of doneIds(lane)) {
      const last = readStatusLog(id, lane).at(-1);
      if (!last || (last.verb !== 'done' && last.verb !== 'failed')) continue;
      const at = Date.parse(last.at) || 0;
      const repo = repoOf(id, lane);
      const ev = readEvidence(id, lane);
      out.push({
        key: `${lane}:${id}`,
        id,
        lane,
        verb: last.verb,
        at: last.at,
        note: last.note,
        repo,
        ...(ev.prUrl ? { prUrl: ev.prUrl } : {}),
        unreported: at > cursorMs(groundsCursorFor(cfg, repo)),
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The repo key a dispatch belongs to, from whichever bucket holds its descriptor. */
export function repoOf(id: string, lane: Lane): string | undefined {
  const dirs = laneDirs(lane);
  for (const file of [
    path.join(dirs.done, id, 'descriptor.json'),
    path.join(dirs.active, id, 'descriptor.json'),
    path.join(dirs.queue, `${id}.json`),
  ]) {
    const d = readJson<Descriptor>(file);
    if (d) return d.repo;
  }
  return undefined;
}

/** One row per pool: size, free, who holds each claimed worktree, and why any is out. */
export function poolRows(pools: PoolView[]): Array<Record<string, string | number>> {
  const list = (p: PoolView, state: PoolView['slots'][number]['state'], text: (s: PoolView['slots'][number]) => string) =>
    p.slots.filter((s) => s.state === state).map((s) => `${s.slot}: ${text(s)}`).join('; ');
  return pools.map((p) => ({
    pool: p.name,
    repo: p.repo,
    size: p.size,
    free: p.free,
    overflow: p.overflow,
    claimed: list(p, 'claimed', (s) => (s.dispatch ?? '').slice(0, 8)),
    out: list(p, 'out', (s) => `${s.reason ?? 'out of rotation'}${s.dispatch ? ` (after ${s.dispatch.slice(0, 8)})` : ''}`),
    warming: [list(p, 'warming', (s) => s.reason ?? 'setting up'), list(p, 'missing', (s) => s.reason ?? 'not created yet')].filter(Boolean).join('; '),
  }));
}

export const POOL_COLUMNS = ['pool', 'repo', 'size', 'free', 'overflow', 'claimed', 'out', 'warming'];

export interface TendReport {
  backends?: ReturnType<typeof backendViews>;
  verdict: 'daemon-down' | 'stalled' | 'needs-attention' | 'working' | 'idle';
  daemon: { up: boolean; lastHeartbeat?: string };
  counts: {
    queued: number;
    active: number;
    headlessActive: number;
    trapActive: number;
    headlessLimit: number;
    /** Dispatches parked on `paused`: they hold no slot. */
    parked?: number;
    choresActive: number;
    done24h: number;
    failed24h: number;
  };
  queueWait?: string;
  attention: TendAttention[];
  stories: TendStory[];
  watches: TendWatch[];
  traps: TendTrap[];
  /** Addressed bait waiting for its trap — sticky, never the daemon's. */
  awaiting: TendAwaiting[];
  notices: TendNotice[];
  helms: Array<{ grounds: string; man: string; session: string; heartbeatAgeSecs: number; worker?: string }>;
  merge?: MergeView;
  stacks: GlassStack[];
  /** Dispatches parked on `paused`, oldest first: what each waits on, and for how long. They hold no slot. */
  parked?: Array<{ id: string; lane: Lane; trap: boolean; since: string; parkedSecs: number; note?: string; waiting?: WaitingView }>;
  /** PR repairs that are due but wait: who holds each and why. Not attention. */
  repairsWaiting: TendRepairWaiting[];
  /** Queued or active daemon repairs in the chore lane. */
  repairChores?: RepairChore[];
  /** A free-space hold: the daemon leaves unaddressed queued work in the queue. */
  hold?: DiskHold & { reason: string };
  /** Worktree pools (`[pools.<name>]`): each slot free, claimed, out of rotation, or warming. */
  pools?: PoolView[];
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function doneIds(lane: Lane): string[] {
  try {
    return fs.readdirSync(laneDirs(lane).done).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * The free-space hold reason for a queued dispatch the daemon would claim,
 * or undefined. Addressed bait waits for its trap, not for disk space.
 */
export function heldReason(id: string, lane: Lane, hold = readHold()): string | undefined {
  if (!hold) return undefined;
  const d = queuedDescriptor(id, lane);
  return d && d.for === undefined ? holdReason(hold) : undefined;
}

function describeDispatch(id: string, lane: Lane, bucket: TendDispatch['bucket'], staleSecs: number): TendDispatch {
  const log = readStatusLog(id, lane);
  const last = log.at(-1);
  // A trap's claim with no report yet is `working`, dated from the claim.
  const claimedAt = bucket === 'active' ? readSessionClaim(id, lane)?.at : undefined;
  const held = bucket === 'queued' ? heldReason(id, lane) : undefined;
  const state = held
    ? 'held'
    : bucket === 'queued'
      ? 'queued'
      : displayState({ log, lastEventAt: lastEventAt(id, lane), queued: false, claimedAt });
  const evidence = readEvidence(id, lane);
  const answered = last && (last.verb === 'needs-decision' || last.verb === 'blocked') ? answeredAt(id, lane, last.at) : undefined;
  return {
    id,
    lane,
    bucket,
    state,
    ...(last?.verb === 'failed' && last.note?.startsWith('budget:') ? { outOfTimeWorkSaved: true } : {}),
    note: held ?? last?.note,
    // Queued work has no log yet; its time is when it entered the queue.
    at: last?.at ?? (bucket === 'queued' ? queuedAt(id, lane) : claimedAt),
    ...(answered ? { answeredAt: answered } : {}),
    prUrl: evidence.prUrl,
    ...(evidence.prUrls && evidence.prUrls.length > 1 ? { prUrls: evidence.prUrls } : {}),
    pr: evidence.pr,
    ...(bucket === 'queued' ? {} : worktreeView(id, lane)),
    ...(bucket === 'queued' ? {} : livenessView(id, lane)),
    ...(bucket === 'active' ? { activity: activityView(readActivity(id, lane), staleSecs) } : {}),
    ...(bucket === 'active' && waitingView(last) ? { waiting: waitingView(last) } : {}),
    ...awaitingView(id),
  };
}

function awaitingView(id: string): Pick<TendDispatch, 'awaitingReply'> {
  const e = awaitingReply(id);
  return e ? { awaitingReply: { sentAt: e.sentAt, from: e.from, line: e.line } } : {};
}

/** Each PR of a chain with more than one, `<state> <url>` when its record exists. */
function prsOf(chain: TendDispatch[]): string[] | undefined {
  const urls = [...new Set(chain.flatMap((d) => d.prUrls ?? []))];
  if (urls.length < 2) return undefined;
  return urls.map((u) => {
    const ref = parsePrRef(u);
    const record = ref ? readPr(ref.key) : undefined;
    return record ? `${prBadge(record).text} ${u}` : u;
  });
}

/**
 * The chain's PR state as a badge — the one derivation tend, catch, and glass
 * share. A chain with several PRs shows the one first seen last.
 */
function prStateOf(chain: TendDispatch[]): string | undefined {
  const records = chain
    .map((d) => parsePrRef(d.prUrl ?? d.pr?.url ?? ''))
    .filter((ref) => ref !== undefined)
    .map((ref) => readPr(ref.key))
    .filter((pr) => pr !== undefined);
  const record = records.sort(prNewestFirst(records))[0];
  if (record) return prBadge(record).text;
  const observed = chain
    .map((d) => d.pr)
    .filter((p): p is PrEvidence => p !== undefined)
    .sort((a, b) => b.number - a.number || b.observedAt.localeCompare(a.observedAt))[0];
  return observed ? prBadge(observed).text : undefined;
}

/** followUp chains: every dispatch whose descriptor points back at `uuid`. */
function followUps(uuid: string): Array<{ id: string; bucket: TendDispatch['bucket'] }> {
  const out: Array<{ id: string; bucket: TendDispatch['bucket'] }> = [];
  const d = laneDirs('work');
  const scan = (id: string, bucket: TendDispatch['bucket'], file: string) => {
    const desc = readJson<Descriptor>(file);
    if (desc?.followUp === uuid) out.push({ id, bucket });
  };
  for (const id of pendingIds('work')) scan(id, 'queued', path.join(d.queue, `${id}.json`));
  for (const id of activeIds('work')) scan(id, 'active', path.join(d.active, id, 'descriptor.json'));
  for (const id of doneIds('work')) scan(id, 'done', path.join(d.done, id, 'descriptor.json'));
  return out;
}

function bucketOf(uuid: string): TendDispatch['bucket'] | undefined {
  const d = laneDirs('work');
  if (fs.existsSync(path.join(d.active, uuid))) return 'active';
  if (fs.existsSync(path.join(d.done, uuid))) return 'done';
  if (fs.existsSync(path.join(d.queue, `${uuid}.json`))) return 'queued';
  return undefined;
}

export function buildTendReport(now = Date.now()): TendReport {
  const cfg = loadConfig();

  const heartbeat = readJson<{ heartbeat?: string }>(executorPath())?.heartbeat;
  const daemonUp = heartbeat !== undefined && now - Date.parse(heartbeat) < HEARTBEAT_STALE_MS;

  const queued = pendingIds('work');
  const active = activeIds('work');
  // A finished dispatch whose runner is still exiting is done, not in flight.
  const inFlight = active.filter((id) => !isFinished(id, 'work'));
  const slots = slotUsage('work');
  // Parked on `paused`: listed with what they wait on, and they hold no slot.
  const parked = parkedDispatches(now);
  const choresActive = activeIds('chore').length + pendingIds('chore').length;

  let done24h = 0;
  let failed24h = 0;
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of doneIds(lane)) {
      const last = readStatusLog(id, lane).at(-1);
      if (!last || now - Date.parse(last.at) > DAY_MS) continue;
      if (last.verb === 'failed') failed24h += 1;
      else if (last.verb === 'done') done24h += 1;
    }
  }

  // Attention is standing state, read straight from the status logs — not
  // the wake cursor. Consuming a wake (a park, a wait) must not make an
  // unanswered question drop out of the status view; remindSecs paces
  // re-WAKES, never visibility.
  const attention: TendReport['attention'] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of [...pendingIds(lane), ...activeIds(lane)]) {
      const last = readStatusLog(id, lane).at(-1);
      if (!last || (last.verb !== 'needs-decision' && last.verb !== 'blocked')) continue;
      // Answered (a message newer than the question) is not standing, even
      // before the worker reads it and reports; the dispatch row carries
      // the marker instead.
      if (answeredAt(id, lane, last.at) !== undefined) continue;
      const key = `${lane}:${id}`;
      const stateHash = statusStateHash(last.verb, last.at);
      const repo = repoOf(id, lane);
      attention.push({
        kind: 'question',
        key,
        stateHash,
        id,
        lane,
        verb: last.verb,
        ageSecs: Math.max(0, Math.round((now - Date.parse(last.at)) / 1000)),
        at: last.at,
        standingSince: last.at,
        note: last.note,
        ...(repo ? { repo } : {}),
        // On the helm's turn: listed here, kept from the pet and the glass.
        ...(questionHeld({ key, stateHash, repo }, now) ? { held: true } : {}),
      });
    }
  }

  // Watches join from disk, same observational stance as the merge view: an
  // unconsumed man-owned event is a standing wake nobody has answered yet.
  const watches: TendWatch[] = [];
  const watchByDispatch = new Map<string, string>();
  for (const w of listWatches()) {
    const events = readWatchEvents(w.key);
    const pending = events.slice(w.seen);
    const last = events.at(-1);
    watches.push({
      key: w.key,
      owner: w.owner,
      cursor: w.cursor,
      pendingEvents: pending.length,
      ...(w.heldAt ? { heldAt: w.heldAt } : {}),
      ...(w.heldAt && w.heldReason ? { heldReason: w.heldReason } : {}),
      lastSummary: last?.summary,
      lastAt: last?.at,
      error: w.lastError ? watchErrorCell(w) : undefined,
    });
    if (w.owner.startsWith('dispatch:')) {
      const label = `${w.key}${pending.length > 0 ? ` (${pending.length} pending)` : ''}`;
      watchByDispatch.set(w.owner.slice('dispatch:'.length), label);
      if (w.lastFollowUpId) watchByDispatch.set(w.lastFollowUpId, label);
    }
    if (w.owner === 'man' && pending.length > 0) {
      const oldest = pending[0];
      attention.push({
        kind: 'watch',
        key: `watch:${w.key}`,
        stateHash: statusStateHash('watch', String(pending.at(-1)?.seq ?? '')),
        id: w.key,
        lane: 'work',
        verb: 'watch',
        ageSecs: oldest?.at ? Math.max(0, Math.round((now - Date.parse(oldest.at)) / 1000)) : 0,
        at: oldest?.at,
        standingSince: oldest?.at,
        note: pending.at(-1)?.summary,
      });
    }
  }

  // Stalled means claiming is broken, not that the queue is deep: work is
  // waiting, capacity is free, the daemon heartbeats, and nothing claims.
  // Addressed (sticky) bait is excluded — it waits for its trap by design
  // and shows in its own `awaiting` table instead of crying wolf here.
  const awaiting: TendAwaiting[] = [];
  const unaddressedQueued: string[] = [];
  const poolQueued = new Set<string>();
  for (const id of queued) {
    const d = queuedDescriptor(id, 'work');
    const st = fs.statSync(path.join(laneDirs('work').queue, `${id}.json`), { throwIfNoEntry: false });
    const ageMins = st ? Math.max(0, Math.round((now - st.mtimeMs) / 60_000)) : 0;
    if (d?.for) awaiting.push({ id, for: d.for, ageMins });
    // Waiting for a queue-mode pool worktree is by design, not a stall.
    else if (d && poolWaits(d, cfg)) poolQueued.add(d.pool!);
    else unaddressedQueued.push(id);
  }
  const oldestQueuedAge = unaddressedQueued.reduce((max, id) => {
    const st = fs.statSync(path.join(laneDirs('work').queue, `${id}.json`), { throwIfNoEntry: false });
    return st ? Math.max(max, now - st.mtimeMs) : max;
  }, 0);
  const hold = readHold();
  // A hold is the daemon choosing not to claim, not claiming broken.
  const stalled =
    !hold && daemonUp && unaddressedQueued.length > 0 && slots.headless < cfg.limits.maxConcurrent && oldestQueuedAge > CLAIM_STALE_MS;

  let queueWait: string | undefined;
  if (unaddressedQueued.length > 0 && slots.headless >= cfg.limits.maxConcurrent) {
    queueWait = `queued work waits: all ${cfg.limits.maxConcurrent} headless slots are in use`;
  } else if (queued.length > 0 && unaddressedQueued.length === 0) {
    const registered = listTraps();
    const notListening = [...new Set(awaiting.map((a) => a.for))].filter((address) => {
      const reg = registered.find((r) => address === `wt:${r.trapId}`);
      return !reg || !!reg.claimed || !reg.firstParkedAt || now - Date.parse(reg.heartbeatAt) > cfg.soak.deferSecs * 1000;
    });
    if (notListening.length) queueWait = `queued work waits: trap ${notListening.map((address) => {
      const reg = registered.find((r) => address === `wt:${r.trapId}`);
      return reg ? trapLabel(reg) : address;
    }).join(', ')} not listening`;
  }
  if (!queueWait && poolQueued.size > 0) queueWait = `queued work waits: no free worktree in pool ${[...poolQueued].join(', ')} (overflow = "queue")`;

  const merge = readMergeView();
  const gateFor = (uuid: string, prUrl?: string): string | undefined => {
    const open = merge?.open.find((p) => p.uuid === uuid || (prUrl !== undefined && p.url === prUrl));
    if (open) return open.gate;
    const recent = merge?.recent.find((r) => prUrl !== undefined && r.url === prUrl);
    return recent?.disposition;
  };

  const staleSecs = cfg.limits.wedgeThresholdSecs;
  const storied = new Set<string>();
  const stories: TendStory[] = [];
  for (const [key, entry] of Object.entries(readPickupMap())) {
    const bucket = bucketOf(entry.uuid);
    if (!bucket) continue; // culled or never landed locally
    const chain = [describeDispatch(entry.uuid, 'work', bucket, staleSecs)];
    for (const f of followUps(entry.uuid)) chain.push(describeDispatch(f.id, 'work', f.bucket, staleSecs));
    for (const d of chain) storied.add(d.id);
    // A story ages out once every dispatch in it is terminal and stale — the
    // mapping is forever, the tend view is about now and the last day.
    const fresh = chain.some((d) => d.bucket !== 'done' || (d.at !== undefined && now - Date.parse(d.at) < DAY_MS));
    if (!fresh) continue;
    const prUrl = chain.map((d) => d.prUrl).find((u) => u !== undefined);
    const watch = chain.map((d) => watchByDispatch.get(d.id)).find((w) => w !== undefined);
    const prs = prsOf(chain);
    stories.push({ key, dispatches: chain, prUrl, ...(prs ? { prs } : {}), prState: prStateOf(chain), gate: gateFor(entry.uuid, prUrl), watch });
  }
  const direct = (d: TendDispatch): TendStory => ({
    key: '(direct)',
    dispatches: [d],
    prUrl: d.prUrl,
    ...(prsOf([d]) ? { prs: prsOf([d]) } : {}),
    prState: prStateOf([d]),
    gate: gateFor(d.id, d.prUrl),
    watch: watchByDispatch.get(d.id),
  });
  for (const id of [...active, ...queued]) {
    if (storied.has(id)) continue;
    stories.push(direct(describeDispatch(id, 'work', bucketOf(id) ?? 'active', staleSecs)));
  }
  // A direct dispatch that landed a PR in the last day stays a story: its PR
  // is still moving (CI, review, merge) after the dispatch reported done.
  for (const id of doneIds('work')) {
    if (storied.has(id)) continue;
    const d = describeDispatch(id, 'work', 'done', staleSecs);
    if (d.prUrl && d.at !== undefined && now - Date.parse(d.at) < DAY_MS) stories.push(direct(d));
  }

  const records = readPrs();
  const legacy = evidencePrs();
  const observed = observedPrs(records, legacy);
  // Stories with a PR take the shared PR order (first seen, newest first) in
  // the slots PR stories hold; a story whose PR has no observation goes last.
  const byPrUrl = new Map(observed.map(({ pr }) => [pr.url, pr]));
  const newestFirst = prNewestFirst(observed.map(({ pr }) => pr));
  const prStories = stories.filter((s) => s.prUrl).sort((a, b) => {
    const pa = byPrUrl.get(a.prUrl!), pb = byPrUrl.get(b.prUrl!);
    return pa && pb ? newestFirst(pa, pb) : Number(!pa) - Number(!pb);
  });
  let prIndex = 0;
  stories.forEach((s, i) => {
    if (s.prUrl) stories[i] = prStories[prIndex++]!;
  });
  const stacks = deriveGlassPrs(
    legacy.map(({ id, pr }) => ({ id, pr })),
    [],
    records,
    { readySettleSecs: cfg.readySettleSecs, now, trunk: (r) => prStackTrunk(cfg, r) },
  ).stacks.filter((s) => s.open);
  attention.push(...landedAttention(cfg, now), ...prAttention(now, observed, cfg), ...reportAttention(now), ...decisionAttention(now), ...hostedAttention(cfg, now));
  // Man-owned member events are represented by the same current stack item,
  // not an independent watch lobster (including obsolete Approval Gate events).
  const stackKeys = new Set(attention.flatMap((a) => a.stack?.members.map((m) => `watch:${m.key}`) ?? []));
  for (let i = attention.length - 1; i >= 0; i--) if (attention[i]!.kind === 'watch' && stackKeys.has(attention[i]!.key)) attention.splice(i, 1);
  // attentionKinds (config.toml) picks what walks; watch events are
  // machinery wakes and always stand.
  const enabled = new Set<string>(cfg.attentionKinds);
  const walking = attention.filter((a) => a.kind === 'watch' ||
    (a.kind === 'stack-ready' ? stackReadyEnabled(cfg) : enabled.has(a.kind)));
  // A question the helm framed as a decision shows as that decision.
  const shown = enabled.has('decision') ? hideFramedQuestions(walking) : walking;
  attention.length = 0;
  // Acks are display-only: they annotate, never remove. The verdict below
  // and every wake path ignore them.
  attention.push(
    ...shown.map((a) => {
      const ack = currentAck(a.key, a.stateHash);
      // A raw question's first view in the glass, scoped to when it was asked.
      const viewedAt = a.kind === 'question' && a.at ? questionViewedAt(a.key, a.at) : undefined;
      const seen = viewedAt ? { ...a, viewedAt } : a;
      return ack ? { ...seen, acked: { at: ack.at, by: ack.by } } : seen;
    }),
  );
  // Attention is a queue of standing conditions. Observation recency only
  // orders the separate PR views, never the pets or this queue.
  attention.sort((a, b) => (a.standingSince ?? a.at ?? '').localeCompare(b.standingSince ?? b.at ?? '') || a.key.localeCompare(b.key));

  const verdict: TendReport['verdict'] = !daemonUp
    ? 'daemon-down'
    : stalled
      ? 'stalled'
      : attention.some((a) => a.kind === 'question' || a.kind === 'decision' || a.kind === 'watch')
        ? 'needs-attention'
        : inFlight.length + queued.length > 0
          ? 'working'
          : 'idle';

  const traps: TendTrap[] = listTraps().map((r) => {
    const hbAgeSecs = Math.max(0, Math.round((now - (Date.parse(r.heartbeatAt) || 0)) / 1000));
    return {
      trap: `wt:${r.trapId}`,
      name: r.name,
      label: trapLabel(r),
      session: r.sessionId.slice(0, 8),
      worker: workerLabel(r),
      repo: r.repo ?? '(addressed only)',
      worktree: r.worktree,
      claimed: r.claimed,
      listening: r.firstParkedAt === undefined ? 'never' : hbAgeSecs <= 10 ? 'now' : `${hbAgeSecs}s ago`,
    };
  });
  // Reserved traps: the address exists, no session has signed on as it yet.
  for (const r of listReservations()) {
    const failed = r.failedAt !== undefined || now > (Date.parse(r.deadline) || 0);
    traps.push({
      trap: `wt:${r.trapId}`,
      name: r.name,
      label: trapLabel(r),
      session: '',
      repo: r.repo,
      worktree: '',
      listening: failed ? 'start failed' : `starting (due in ${Math.max(0, Math.round(((Date.parse(r.deadline) || 0) - now) / 1000))}s)`,
      state: failed ? 'start-failed' : 'starting',
    });
  }

  const notices: TendNotice[] = listNotices(5).map((n) => ({
    kind: n.kind,
    ageMins: Math.max(0, Math.round((now - (Date.parse(n.at) || 0)) / 60_000)),
    text: n.text,
    ...(n.url ? { url: n.url } : {}),
  }));

  const pools = poolViews(cfg);
  const helms = listHelms().map((h) => ({
    grounds: displayGrounds(h.grounds, cfg),
    man: helmLabel(h),
    session: h.sessionId.slice(0, 8),
    worker: workerLabel(h),
    heartbeatAgeSecs: Math.max(0, Math.round((now - (Date.parse(h.heartbeatAt) || 0)) / 1000)),
  }));

  return {
    verdict,
    backends: backendViews(cfg),
    daemon: { up: daemonUp, lastHeartbeat: heartbeat },
    counts: {
      queued: queued.length,
      active: inFlight.length,
      headlessActive: slots.headless,
      trapActive: slots.traps,
      headlessLimit: cfg.limits.maxConcurrent,
      parked: parked.length,
      choresActive,
      done24h,
      failed24h,
    },
    queueWait,
    attention,
    stories,
    watches,
    traps,
    awaiting,
    notices,
    helms,
    merge,
    stacks,
    parked: parked.map((p) => ({
      id: p.id,
      lane: p.lane,
      trap: p.trap,
      since: p.since,
      parkedSecs: p.parkedSecs,
      ...(p.note ? { note: p.note } : {}),
      ...(p.waiting ? { waiting: p.waiting } : {}),
    })),
    repairsWaiting: waitingRepairs(records).map((pr) => ({
      key: pr.key,
      url: pr.url,
      kind: pr.repair!.kind,
      heldBy: pr.repair!.heldBy ?? '',
      reason: pr.repair!.reason ?? '',
      ...(pr.repair!.until ? { until: pr.repair!.until } : {}),
    })),
    repairChores: repairChores(records),
    ...(hold ? { hold: { ...hold, reason: holdReason(hold) } } : {}),
    ...(pools.length > 0 ? { pools } : {}),
  };
}

export function renderTend(r: TendReport): string {
  const lines: string[] = [];
  for (const b of r.backends ?? []) lines.push(toonKV({ grounds: b.grounds, backend: b.wharf ?? 'local', ...(b.unavailable ? { state: 'unknown', note: b.unavailable } : {}) }));
  // Tables show each trap by name alone; `wt:<id>` only where no name is known.
  const names = trapNamer();
  const named = (text: string) => nameTrapsIn(text, 'name', names);
  lines.push(
    toonKV({
      verdict: r.verdict,
      daemon: r.daemon.up ? 'up' : `down (last heartbeat ${r.daemon.lastHeartbeat ?? 'never'})`,
      queued: r.counts.queued,
      active: `headless: ${r.counts.headlessActive} of ${r.counts.headlessLimit}; traps: ${r.counts.trapActive}${r.counts.parked ? `; parked: ${r.counts.parked} (no slot)` : ''}`,
      chores: r.counts.choresActive,
      done24h: r.counts.done24h,
      failed24h: r.counts.failed24h,
      ...(r.hold ? { diskHold: `${r.hold.reason} on ${r.hold.dir} (since ${r.hold.since})` } : {}),
    }),
  );
  if (r.queueWait) lines.push(r.queueWait);
  for (const stack of r.stacks) {
    lines.push(`stack ${stack.numbers.map((n) => `#${n}`).join(' → ')}: next ${stack.nextNumber ? `#${stack.nextNumber}` : 'none'}`);
    if (stack.readiness) lines.push(`${stack.readiness.text} ${stack.readiness.url}`);
    const item = r.attention.find((a) => a.key === `stack:${stack.readiness?.id}`);
    if (item?.stack) for (const member of item.stack.members) lines.push(`  ${member.note} ${member.url}`);
  }
  if (r.attention.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'attention',
        r.attention.map((a) => ({
          id: a.id,
          verb: a.kind === 'question' || a.kind === 'watch' ? a.verb : a.kind === 'landed' ? `landed (${a.verb})` : attentionKindLabel(a),
          waitingMins: Math.round(a.ageSecs / 60),
          held: a.held ? 'yes' : '',
          // Whether the human has opened it in the glass's decision modal,
          // or acked a report (opening its page acks it).
          viewed:
            a.kind === 'decision' || a.kind === 'question'
              ? a.viewedAt ? `yes ${a.viewedAt}` : 'no'
              : a.kind === 'report'
                ? a.acked ? `yes ${a.acked.at}` : 'no'
                : '',
          note: named(a.prUrl ? `${a.note ?? ''} ${a.prUrl}`.trim() : (a.note ?? '')),
        })),
        ['id', 'verb', 'waitingMins', 'held', 'viewed', 'note'],
      ),
    );
  }
  if (r.stories.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'work',
        r.stories.map((s) => ({
          key: s.key,
          dispatches: s.dispatches
            .map(
              (d) =>
                `${d.id.slice(0, 8)}:${d.outOfTimeWorkSaved ? 'out of time, work saved' : d.state}` +
                (d.state === 'held' && d.note ? ` (${named(d.note.replace(/^held: /, ''))})` : '') +
                (d.answeredAt ? ` (answered ${Math.max(0, Math.round((Date.now() - Date.parse(d.answeredAt)) / 60_000))}m ago)` : '') +
                (d.waiting ? ` (${waitingText(d.waiting)})` : '') +
                (d.awaitingReply ? ` (awaiting reply · ${ageLabel(Date.now() - (Date.parse(d.awaitingReply.sentAt) || Date.now()))})` : ''),
            )
            .join(' → '),
          pr: s.prs ? s.prs.join('; ') : s.prState ? `${s.prState} ${s.prUrl ?? ''}`.trim() : (s.prUrl ?? ''),
          gate: s.gate ?? '',
          watch: s.watch ?? '',
          // Under the verb and note: what the live dispatch is doing now.
          activity: s.dispatches
            .filter((d) => d.activity)
            .map((d) => (s.dispatches.length > 1 ? `${d.id.slice(0, 8)}: ` : '') + activityLine(d.activity!))
            .join('; '),
          progress: s.dispatches
            .map((d) => [d.elapsed, d.attempt ? `attempt ${d.attempt}` : '', d.branch, d.lastCommit, d.aheadTrunk, d.draftPr]
              .filter(Boolean).join(' · '))
            .filter(Boolean).join('; '),
        })),
        ['key', 'dispatches', 'pr', 'gate', 'watch', 'activity', 'progress'],
      ),
    );
  }
  if (r.parked?.length) {
    lines.push('');
    lines.push(
      toonTable(
        'parked (no slot)',
        r.parked.map((p) => ({
          id: p.id.slice(0, 8),
          waitingOn: p.waiting?.on ?? '',
          for: ageLabel(p.parkedSecs * 1000),
          link: p.waiting?.link ?? '',
          note: named(`${p.note ?? ''}${p.trap ? ' (trap)' : ''}`.trim()),
        })),
        ['id', 'waitingOn', 'for', 'link', 'note'],
      ),
    );
  }
  if (r.repairsWaiting?.length) {
    lines.push('');
    lines.push(
      toonTable(
        'repairs waiting',
        r.repairsWaiting.map((w) => ({ pr: w.key, kind: w.kind, heldBy: named(w.heldBy), reason: named(w.reason), until: w.until ?? '' })),
        ['pr', 'kind', 'heldBy', 'reason', 'until'],
      ),
    );
  }
  if (r.repairChores?.length) {
    lines.push('');
    lines.push(toonTable('repair chores', r.repairChores.map((c) => ({
      id: c.id.slice(0, 8), pr: c.pr, lane: c.lane, state: c.state,
      worker: named(c.worker), waitingForTrap: c.waitingForTrap ? `until ${c.until ?? '?'}` : '',
    })), ['id', 'pr', 'lane', 'state', 'worker', 'waitingForTrap']));
  }
  if (r.pools?.length) {
    lines.push('');
    lines.push(toonTable('pools', poolRows(r.pools), POOL_COLUMNS));
  }
  if (r.watches.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'watches',
        r.watches.map((w) => ({
          key: w.key,
          owner: w.owner,
          pending: w.pendingEvents,
          held: w.heldAt ? `held: ${w.heldReason ?? 'held'}` : '',
          last: w.lastSummary ?? '',
          error: w.error ?? '',
        })),
        ['key', 'owner', 'pending', 'held', 'last', 'error'],
      ),
    );
  }
  if (r.traps.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'traps',
        r.traps.map((s) => ({
          name: s.name ?? '',
          trap: s.trap,
          session: s.session,
          worker: s.worker ?? '',
          repo: s.repo,
          claimed: s.claimed ? s.claimed.slice(0, 8) : '',
          listening: s.listening,
          worktree: s.worktree,
        })),
        ['name', 'trap', 'session', 'worker', 'repo', 'claimed', 'listening', 'worktree'],
      ),
    );
  }
  if (r.awaiting.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'awaiting-trap (sticky — never claimed headless)',
        r.awaiting.map((a) => ({ id: a.id.slice(0, 8), for: named(a.for), waitingMins: a.ageMins })),
        ['id', 'for', 'waitingMins'],
      ),
    );
  }
  if (r.notices.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'notices (recent)',
        r.notices.map((n) => ({ kind: n.kind, ageMins: n.ageMins, text: `${n.text}${n.url ? ` ${n.url}` : ''}` })),
        ['kind', 'ageMins', 'text'],
      ),
    );
  }
  if (r.helms.length > 0) {
    lines.push('');
    lines.push(
      toonKV({
        helm: r.helms.map((h) => `${h.grounds}=${h.man} [${h.session}] ${h.worker ?? ''} (${h.heartbeatAgeSecs}s ago)`).join(', '),
      }),
    );
  }
  if (r.merge && (r.merge.open.length > 0 || r.merge.recent.length > 0)) {
    lines.push('');
    lines.push(
      toonTable(
        `prs (${r.merge.repo}, observed ${r.merge.updatedAt})`,
        [
          ...r.merge.open.map((p) => ({ pr: `#${p.number}`, state: p.mergeableState, gate: p.gate, url: p.url })),
          ...r.merge.recent.map((p) => ({ pr: `#${p.number}`, state: p.disposition, gate: '', url: p.url })),
        ],
        ['pr', 'state', 'gate', 'url'],
      ),
    );
  }
  return lines.join('\n');
}
