import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  activeIds,
  executorPath,
  laneDirs,
  lastEventAt,
  helmLabel,
  listHelms,
  listNotices,
  listTraps,
  listWatches,
  loadConfig,
  pendingIds,
  prBadge,
  queuedDescriptor,
  readEvidence,
  readStatusLog,
  readWatchEvents,
  reconcile,
  toonKV,
  toonTable,
} from '@lobstah/core';
import type { Descriptor, Lane, PrEvidence } from '@lobstah/core';
import { readMergeView, readPickupMap } from '@lobstah/pick';
import type { MergeView } from '@lobstah/pick';

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
 * One thing awaiting a human. `question` is a standing needs-decision /
 * blocked; `watch` an unconsumed man-owned watch event; `pr` a dispatch's
 * PR that its pr: watch observed open and still in draft — it walks until
 * the PR leaves draft, merges, or closes. Only questions and watch events
 * drive the verdict: a draft PR is something to look at, not a stall.
 */
export interface TendAttention {
  kind: 'question' | 'watch' | 'pr';
  id: string;
  lane: Lane;
  verb: string;
  ageSecs: number;
  at?: string;
  note?: string;
  /** kind pr only */
  prUrl?: string;
  draft?: boolean;
  checks?: PrEvidence['checks'];
}

/**
 * Draft PRs from evidence — the pr: watch's observation, never a forge call.
 * One item per PR URL (a chain may carry the same PR on several members;
 * the newest observation wins). Evidence carries no PR title, so the note
 * is `#<n> draft`.
 */
export function draftPrAttention(now = Date.now()): TendAttention[] {
  const byUrl = new Map<string, { item: TendAttention; observedAt: string }>();
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
      if (!pr || pr.state !== 'OPEN' || !pr.draft) continue;
      const prev = byUrl.get(pr.url);
      if (prev && prev.observedAt >= pr.observedAt) continue;
      const since = readStatusLog(id, lane).at(-1)?.at ?? pr.observedAt;
      byUrl.set(pr.url, {
        observedAt: pr.observedAt,
        item: {
          kind: 'pr',
          id,
          lane,
          verb: 'pr',
          ageSecs: Math.max(0, Math.round((now - Date.parse(since)) / 1000)),
          at: since,
          note: `#${pr.number} draft`,
          prUrl: pr.url,
          draft: true,
          checks: pr.checks,
        },
      });
    }
  }
  return [...byUrl.values()].map((v) => v.item).sort((a, b) => b.ageSecs - a.ageSecs);
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
  return { id, lane, bucket, state, note: last?.note, at: last?.at, prUrl: evidence.prUrl, pr: evidence.pr };
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
      attention.push({
        kind: 'question',
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

  attention.push(...draftPrAttention(now));

  const verdict: TendReport['verdict'] = !daemonUp
    ? 'daemon-down'
    : stalled
      ? 'stalled'
      : attention.some((a) => a.kind !== 'pr')
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
  if (r.attention.length > 0) {
    lines.push('');
    lines.push(
      toonTable(
        'attention',
        r.attention.map((a) => ({
          id: a.id,
          verb: a.verb,
          waitingMins: Math.round(a.ageSecs / 60),
          note: a.kind === 'pr' ? `${a.note ?? ''} ${a.prUrl ?? ''}`.trim() : (a.note ?? ''),
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
          dispatches: s.dispatches.map((d) => `${d.id.slice(0, 8)}:${d.state}`).join(' → '),
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
