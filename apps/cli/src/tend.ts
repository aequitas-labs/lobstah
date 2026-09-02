import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  activeIds,
  executorPath,
  laneDirs,
  lastEventAt,
  loadConfig,
  pendingIds,
  readEvidence,
  readStatusLog,
  reconcile,
  toonKV,
  toonTable,
} from '@lobstah/core';
import type { Descriptor, Lane } from '@lobstah/core';
import { attentionNow } from '@lobstah/supervisor';
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
}

export interface TendStory {
  /** Tracker key ("linear:BAS-12", "gh:owner/repo#3") or "(direct)". */
  key: string;
  dispatches: TendDispatch[];
  prUrl?: string;
  /** Merge-gate verdict from the pick snapshot, when one matches. */
  gate?: string;
}

export interface TendReport {
  verdict: 'daemon-down' | 'stalled' | 'needs-attention' | 'working' | 'idle';
  daemon: { up: boolean; lastHeartbeat?: string };
  counts: { queued: number; active: number; choresActive: number; done24h: number; failed24h: number };
  attention: Array<{ id: string; lane: Lane; verb: string; ageSecs: number; note?: string }>;
  stories: TendStory[];
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
  return { id, lane, bucket, state, note: last?.note, at: last?.at, prUrl: evidence.prUrl };
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

  const remindMs = (cfg.remindSecs ?? 900) * 1000;
  const attention = attentionNow(false, remindMs, now).map((ev) => ({
    id: ev.id,
    lane: ev.lane,
    verb: ev.entry.verb as string,
    ageSecs: Math.max(0, Math.round((now - Date.parse(ev.entry.at)) / 1000)),
    note: ev.entry.note,
  }));

  // Stalled means claiming is broken, not that the queue is deep: work is
  // waiting, capacity is free, the daemon heartbeats, and nothing claims.
  const oldestQueuedAge = queued.reduce((max, id) => {
    const st = fs.statSync(path.join(laneDirs('work').queue, `${id}.json`), { throwIfNoEntry: false });
    return st ? Math.max(max, now - st.mtimeMs) : max;
  }, 0);
  const stalled =
    daemonUp && queued.length > 0 && active.length < cfg.limits.maxConcurrent && oldestQueuedAge > CLAIM_STALE_MS;

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
    stories.push({ key, dispatches: chain, prUrl, gate: gateFor(entry.uuid, prUrl) });
  }
  for (const id of [...active, ...queued]) {
    if (storied.has(id)) continue;
    const d = describeDispatch(id, 'work', bucketOf(id) ?? 'active');
    stories.push({ key: '(direct)', dispatches: [d], prUrl: d.prUrl, gate: gateFor(id, d.prUrl) });
  }

  const verdict: TendReport['verdict'] = !daemonUp
    ? 'daemon-down'
    : stalled
      ? 'stalled'
      : attention.length > 0
        ? 'needs-attention'
        : active.length + queued.length > 0
          ? 'working'
          : 'idle';

  return {
    verdict,
    daemon: { up: daemonUp, lastHeartbeat: heartbeat },
    counts: { queued: queued.length, active: active.length, choresActive, done24h, failed24h },
    attention,
    stories,
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
        r.attention.map((a) => ({ id: a.id, verb: a.verb, waitingMins: Math.round(a.ageSecs / 60), note: a.note ?? '' })),
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
          pr: s.prUrl ?? '',
          gate: s.gate ?? '',
        })),
        ['key', 'dispatches', 'pr', 'gate'],
      ),
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
