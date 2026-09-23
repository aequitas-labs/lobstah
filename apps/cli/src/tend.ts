import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  activeIds,
  answeredAt,
  executorPath,
  laneDirs,
  lastEventAt,
  helmLabel,
  listHelms,
  listNotices,
  listTraps,
  listWatches,
  loadConfig,
  parsePrRef,
  pendingIds,
  prBadge,
  queuedDescriptor,
  readEvidence,
  readPrs,
  readStatusLog,
  readWatch,
  readWatchEvents,
  reconcile,
  toonKV,
  toonTable,
} from '@lobstah/core';
import type { AttentionKind, Config, Descriptor, Lane, PrEvidence } from '@lobstah/core';
import { readMergeView, readPickupMap } from '@lobstah/pick';
import { reportedThroughMs } from './reported.js';
import { currentAck, prStateHash, statusStateHash } from './acks.js';
import type { MergeView } from '@lobstah/pick';
import { deriveGlassPrs } from './glass-prs.js';
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
  note?: string;
  at?: string;
  /** A needs-decision / blocked the helm (or anyone) has answered but the worker hasn't acted on yet. */
  answeredAt?: string;
  prUrl?: string;
  /** PR state as last observed by the chain's pr: watch. */
  pr?: PrEvidence;
}

export interface TendStory {
  /** Tracker key ("linear:BAS-12", "gh:owner/repo#3") or "(direct)". */
  key: string;
  dispatches: TendDispatch[];
  prUrl?: string;
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
  lastSummary?: string;
  lastAt?: string;
  error?: string;
}

export interface TendTrap {
  trap: string;
  session: string;
  repo: string;
  worktree: string;
  claimed?: string;
  /** never | now (parked) | <age>s ago */
  listening: string;
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
}

/**
 * One thing awaiting a human (docs/vocabulary.md, "Attention contract").
 * Each kind stands while its condition holds and clears on its own:
 * - `question`: the dispatch's last status is needs-decision / blocked.
 * - `landed`: the dispatch is done / failed after the grounds' reported-through cursor.
 * - `pr:draft`: evidence pr open and draft.
 * - `pr:review`: open, with unresolved review threads or changes requested.
 * - `pr:checks`: open, with failed checks on the observed head.
 * - `pr:ready`: open, not draft, no pr:review standing, approved or all checks passed with none pending.
 * - `watch`: an unconsumed man-owned watch event — machinery, always on.
 * Only `question` and `watch` drive the verdict; the rest are things to look at.
 */
export type TendAttentionKind = AttentionKind | 'watch';

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
  note?: string;
  repo?: string;
  /** pr:* kinds: the evidence fields the kind derives from. */
  prUrl?: string;
  number?: number;
  state?: string;
  draft?: boolean;
  reviewDecision?: string;
  headSha?: string;
  checks?: PrEvidence['checks'];
  review?: PrEvidence['review'];
}

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
  return chain.find(
    (m) => m.bucket !== 'done' && (owners.reviewRounds.has(m.id) || m.id === owners.watchFollowUp),
  )?.id;
}

/** Which pr:* kinds a PR's evidence stands on right now. Pure. */
export function prKinds(pr: PrEvidence): AttentionKind[] {
  if (pr.state !== 'OPEN') return [];
  const out: AttentionKind[] = [];
  const { failed, pending, total } = pr.checks;
  if (pr.draft) out.push('pr:draft');
  const review = (pr.review?.unresolvedThreads ?? 0) > 0 || pr.review?.changesRequested === true;
  if (review) out.push('pr:review');
  if (failed > 0) out.push('pr:checks');
  // Ready never contradicts review: outstanding threads or a changes request mean not ready yet.
  if (!pr.draft && !review && (pr.reviewDecision === 'APPROVED' || (total > 0 && failed === 0 && pending === 0))) out.push('pr:ready');
  return out;
}

/** Ready is a merge invitation only when no tracked open PR is its base. */
export function readyBlockedByStack(pr: PrEvidence, tracked: readonly PrEvidence[]): boolean {
  if (pr.state !== 'OPEN' || !pr.baseRefName) return false;
  const ref = parsePrRef(pr.url);
  return tracked.some((other) => {
    const parent = parsePrRef(other.url);
    return other.url !== pr.url && other.state === 'OPEN' && other.headRefName === pr.baseRefName &&
      ref?.owner === parent?.owner && ref?.repo === parent?.repo;
  });
}

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
  'pr:ready': (pr) => `#${pr.number} ready to merge`,
};

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
    out.push(owner ? { id: owner, lane: dispatchLane(owner)!, pr: r, dispatch: true } : { id: r.key, lane: 'work', pr: r, dispatch: false });
  }
  for (const e of legacy) if (!seen.has(e.pr.url)) out.push({ ...e, dispatch: true });
  return out;
}

function prAttention(now: number, observed = observedPrs()): TendAttention[] {
  const reviewRounds = new Set(
    Object.values(readPickupMap())
      .filter((e) => e.kind === 'review')
      .map((e) => e.uuid),
  );
  const out: TendAttention[] = [];
  for (const { id, lane, pr, dispatch } of observed) {
    const kinds = prKinds(pr).filter((kind) => kind !== 'pr:ready' || !readyBlockedByStack(pr, observed.map((x) => x.pr)));
    if (kinds.length === 0) continue;
    const ref = parsePrRef(pr.url);
    const watchFollowUp = ref ? readWatch(ref.key)?.lastFollowUpId : undefined;
    const chain = dispatch ? chainOf(id) : [];
    const since = (dispatch ? readStatusLog(id, lane).at(-1)?.at : undefined) ?? pr.observedAt;
    for (const kind of kinds) {
      if (onTheHook(kind, chain, { reviewRounds, watchFollowUp })) continue;
      out.push({
        kind,
        key: ref?.key ?? pr.url,
        stateHash: prStateHash(pr),
        id,
        lane,
        verb: kind,
        ageSecs: Math.max(0, Math.round((now - Date.parse(since)) / 1000)),
        at: since,
        note: PR_KIND_NOTE[kind]!(pr),
        repo: dispatch ? repoOf(id, lane) : (ref ? `${ref.owner}/${ref.repo}` : undefined),
        prUrl: pr.url,
        number: pr.number,
        state: pr.state,
        draft: pr.draft,
        reviewDecision: pr.reviewDecision,
        headSha: pr.headSha,
        checks: pr.checks,
        ...(pr.review ? { review: pr.review } : {}),
      });
    }
  }
  return out.sort((a, b) => b.ageSecs - a.ageSecs);
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
        note: last.note,
        repo,
        ...(ev.prUrl ? { prUrl: ev.prUrl } : {}),
      });
    }
  }
  return out.sort((a, b) => b.ageSecs - a.ageSecs);
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

export interface TendReport {
  verdict: 'daemon-down' | 'stalled' | 'needs-attention' | 'working' | 'idle';
  daemon: { up: boolean; lastHeartbeat?: string };
  counts: { queued: number; active: number; choresActive: number; done24h: number; failed24h: number };
  attention: TendAttention[];
  stories: TendStory[];
  watches: TendWatch[];
  traps: TendTrap[];
  /** Addressed bait waiting for its trap — sticky, never the daemon's. */
  awaiting: TendAwaiting[];
  notices: TendNotice[];
  helms: Array<{ grounds: string; man: string; session: string; heartbeatAgeSecs: number }>;
  merge?: MergeView;
  stacks: GlassStack[];
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

function describeDispatch(id: string, lane: Lane, bucket: TendDispatch['bucket']): TendDispatch {
  const log = readStatusLog(id, lane);
  const last = log.at(-1);
  const state = bucket === 'queued' ? 'queued' : reconcile({ log, lastEventAt: lastEventAt(id, lane) });
  const evidence = readEvidence(id, lane);
  const answered =
    last && (last.verb === 'needs-decision' || last.verb === 'blocked') ? answeredAt(id, lane, last.at) : undefined;
  return {
    id,
    lane,
    bucket,
    state,
    note: last?.note,
    at: last?.at,
    ...(answered ? { answeredAt: answered } : {}),
    prUrl: evidence.prUrl,
    pr: evidence.pr,
  };
}

/** The chain's newest observed PR state as a badge — the one derivation tend, catch, and glass share. */
function prStateOf(chain: TendDispatch[]): string | undefined {
  const observed = chain
    .map((d) => d.pr)
    .filter((p): p is PrEvidence => p !== undefined)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
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
      attention.push({
        kind: 'question',
        key: `${lane}:${id}`,
        stateHash: statusStateHash(last.verb, last.at),
        id,
        lane,
        verb: last.verb,
        ageSecs: Math.max(0, Math.round((now - Date.parse(last.at)) / 1000)),
        at: last.at,
        note: last.note,
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
      lastSummary: last?.summary,
      lastAt: last?.at,
      error: w.lastError,
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
  for (const id of queued) {
    const d = queuedDescriptor(id, 'work');
    const st = fs.statSync(path.join(laneDirs('work').queue, `${id}.json`), { throwIfNoEntry: false });
    const ageMins = st ? Math.max(0, Math.round((now - st.mtimeMs) / 60_000)) : 0;
    if (d?.for) awaiting.push({ id, for: d.for, ageMins });
    else unaddressedQueued.push(id);
  }
  const oldestQueuedAge = unaddressedQueued.reduce((max, id) => {
    const st = fs.statSync(path.join(laneDirs('work').queue, `${id}.json`), { throwIfNoEntry: false });
    return st ? Math.max(max, now - st.mtimeMs) : max;
  }, 0);
  const stalled =
    daemonUp &&
    unaddressedQueued.length > 0 &&
    active.length < cfg.limits.maxConcurrent &&
    oldestQueuedAge > CLAIM_STALE_MS;

  const merge = readMergeView();
  const gateFor = (uuid: string, prUrl?: string): string | undefined => {
    const open = merge?.open.find((p) => p.uuid === uuid || (prUrl !== undefined && p.url === prUrl));
    if (open) return open.gate;
    const recent = merge?.recent.find((r) => prUrl !== undefined && r.url === prUrl);
    return recent?.disposition;
  };

  const storied = new Set<string>();
  const stories: TendStory[] = [];
  for (const [key, entry] of Object.entries(readPickupMap())) {
    const bucket = bucketOf(entry.uuid);
    if (!bucket) continue; // culled or never landed locally
    const chain = [describeDispatch(entry.uuid, 'work', bucket)];
    for (const f of followUps(entry.uuid)) chain.push(describeDispatch(f.id, 'work', f.bucket));
    for (const d of chain) storied.add(d.id);
    // A story ages out once every dispatch in it is terminal and stale — the
    // mapping is forever, the tend view is about now and the last day.
    const fresh = chain.some((d) => d.bucket !== 'done' || (d.at !== undefined && now - Date.parse(d.at) < DAY_MS));
    if (!fresh) continue;
    const prUrl = chain.map((d) => d.prUrl).find((u) => u !== undefined);
    const watch = chain.map((d) => watchByDispatch.get(d.id)).find((w) => w !== undefined);
    stories.push({ key, dispatches: chain, prUrl, prState: prStateOf(chain), gate: gateFor(entry.uuid, prUrl), watch });
  }
  const direct = (d: TendDispatch): TendStory => ({
    key: '(direct)',
    dispatches: [d],
    prUrl: d.prUrl,
    prState: prStateOf([d]),
    gate: gateFor(d.id, d.prUrl),
    watch: watchByDispatch.get(d.id),
  });
  for (const id of [...active, ...queued]) {
    if (storied.has(id)) continue;
    stories.push(direct(describeDispatch(id, 'work', bucketOf(id) ?? 'active')));
  }
  // A direct dispatch that landed a PR in the last day stays a story: its PR
  // is still moving (CI, review, merge) after the dispatch reported done.
  for (const id of doneIds('work')) {
    if (storied.has(id)) continue;
    const d = describeDispatch(id, 'work', 'done');
    if (d.prUrl && d.at !== undefined && now - Date.parse(d.at) < DAY_MS) stories.push(direct(d));
  }

  const records = readPrs();
  const legacy = evidencePrs();
  const observed = observedPrs(records, legacy);
  const stacks = deriveGlassPrs(legacy.map(({ id, pr }) => ({ id, pr })), [], records).stacks.filter((s) => s.open);
  attention.push(...landedAttention(cfg, now), ...prAttention(now, observed));
  // attentionKinds (config.toml) picks what walks; watch events are
  // machinery wakes and always stand.
  const enabled = new Set<string>(cfg.attentionKinds);
  const shown = attention.filter((a) => a.kind === 'watch' || enabled.has(a.kind));
  attention.length = 0;
  // Acks are display-only: they annotate, never remove. The verdict below
  // and every wake path ignore them.
  attention.push(
    ...shown.map((a) => {
      const ack = currentAck(a.key, a.stateHash);
      return ack ? { ...a, acked: { at: ack.at, by: ack.by } } : a;
    }),
  );

  const verdict: TendReport['verdict'] = !daemonUp
    ? 'daemon-down'
    : stalled
      ? 'stalled'
      : attention.some((a) => a.kind === 'question' || a.kind === 'watch')
        ? 'needs-attention'
        : active.length + queued.length > 0
          ? 'working'
          : 'idle';

  const traps: TendTrap[] = listTraps().map((r) => {
    const hbAgeSecs = Math.max(0, Math.round((now - (Date.parse(r.heartbeatAt) || 0)) / 1000));
    return {
      trap: `wt:${r.trapId}`,
      session: r.sessionId.slice(0, 8),
      repo: r.repo ?? '(addressed only)',
      worktree: r.worktree,
      claimed: r.claimed,
      listening: r.firstParkedAt === undefined ? 'never' : hbAgeSecs <= 10 ? 'now' : `${hbAgeSecs}s ago`,
    };
  });

  const notices: TendNotice[] = listNotices(5).map((n) => ({
    kind: n.kind,
    ageMins: Math.max(0, Math.round((now - (Date.parse(n.at) || 0)) / 60_000)),
    text: n.text,
  }));

  const helms = listHelms().map((h) => ({
    grounds: h.grounds,
    man: helmLabel(h),
    session: h.sessionId.slice(0, 8),
    heartbeatAgeSecs: Math.max(0, Math.round((now - (Date.parse(h.heartbeatAt) || 0)) / 1000)),
  }));

  return {
    verdict,
    daemon: { up: daemonUp, lastHeartbeat: heartbeat },
    counts: { queued: queued.length, active: active.length, choresActive, done24h, failed24h },
    attention,
    stories,
    watches,
    traps,
    awaiting,
    notices,
    helms,
    merge,
    stacks,
  };
}

export function renderTend(r: TendReport): string {
  const lines: string[] = [];
  lines.push(
    toonKV({
      verdict: r.verdict,
      daemon: r.daemon.up ? 'up' : `down (last heartbeat ${r.daemon.lastHeartbeat ?? 'never'})`,
      queued: r.counts.queued,
      active: r.counts.active,
      chores: r.counts.choresActive,
      done24h: r.counts.done24h,
      failed24h: r.counts.failed24h,
    }),
  );
  for (const stack of r.stacks) {
    lines.push(`stack ${stack.numbers.map((n) => `#${n}`).join(' → ')}: next ${stack.nextNumber ? `#${stack.nextNumber}` : 'none'}`);
  }
  if (r.attention.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'attention',
        r.attention.map((a) => ({
          id: a.id,
          verb: a.kind === 'question' || a.kind === 'watch' ? a.verb : a.kind === 'landed' ? `landed (${a.verb})` : a.kind,
          waitingMins: Math.round(a.ageSecs / 60),
          note: a.prUrl ? `${a.note ?? ''} ${a.prUrl}`.trim() : (a.note ?? ''),
        })),
        ['id', 'verb', 'waitingMins', 'note'],
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
                `${d.id.slice(0, 8)}:${d.state}` +
                (d.answeredAt ? ` (answered ${Math.max(0, Math.round((Date.now() - Date.parse(d.answeredAt)) / 60_000))}m ago)` : ''),
            )
            .join(' → '),
          pr: s.prState ? `${s.prState} ${s.prUrl ?? ''}`.trim() : (s.prUrl ?? ''),
          gate: s.gate ?? '',
          watch: s.watch ?? '',
        })),
        ['key', 'dispatches', 'pr', 'gate', 'watch'],
      ),
    );
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
          last: w.lastSummary ?? '',
          error: w.error ?? '',
        })),
        ['key', 'owner', 'pending', 'last', 'error'],
      ),
    );
  }
  if (r.traps.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'traps',
        r.traps.map((s) => ({
          trap: s.trap,
          session: s.session,
          repo: s.repo,
          claimed: s.claimed ? s.claimed.slice(0, 8) : '',
          listening: s.listening,
          worktree: s.worktree,
        })),
        ['trap', 'session', 'repo', 'claimed', 'listening', 'worktree'],
      ),
    );
  }
  if (r.awaiting.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'awaiting-trap (sticky — never claimed headless)',
        r.awaiting.map((a) => ({ id: a.id.slice(0, 8), for: a.for, waitingMins: a.ageMins })),
        ['id', 'for', 'waitingMins'],
      ),
    );
  }
  if (r.notices.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'notices (recent)',
        r.notices.map((n) => ({ kind: n.kind, ageMins: n.ageMins, text: n.text })),
        ['kind', 'ageMins', 'text'],
      ),
    );
  }
  if (r.helms.length > 0) {
    lines.push('');
    lines.push(
      toonKV({
        helm: r.helms.map((h) => `${h.grounds}=${h.man} [${h.session}] (${h.heartbeatAgeSecs}s ago)`).join(', '),
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
