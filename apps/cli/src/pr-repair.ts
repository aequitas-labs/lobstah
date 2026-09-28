import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  branchOwnership,
  enqueue,
  laneDirs,
  lastEventAt,
  listWatches,
  loadConfig,
  lobstahHome,
  markFollowUp,
  readEvidence,
  readPr,
  readSessionClaim,
  readStatusLog,
  readTrap,
  readWatchEvents,
  reconcile,
  repairBrief,
  repairKind,
  repairLimit,
  storedDescriptor,
  withPrLock,
  writePr,
} from '@lobstah/core';
import type { Descriptor, Lane, PrCommit, PrRecord, Watch } from '@lobstah/core';

export interface RepairerBeat {
  process: string;
  pid: number;
  at: string;
}
const beatFile = () => path.join(lobstahHome(), 'repairer.json');

export function stampRepairerBeat(now = Date.now(), processName = 'daemon'): void {
  fs.mkdirSync(lobstahHome(), { recursive: true });
  const tmp = `${beatFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ process: processName, pid: process.pid, at: new Date(now).toISOString() } satisfies RepairerBeat));
  fs.renameSync(tmp, beatFile());
}

export function readRepairerBeat(): RepairerBeat | undefined {
  try {
    const beat = JSON.parse(fs.readFileSync(beatFile(), 'utf8')) as RepairerBeat;
    return typeof beat.process === 'string' && typeof beat.at === 'string' ? beat : undefined;
  } catch {
    return undefined;
  }
}

export function liveRepairer(now = Date.now()): RepairerBeat | undefined {
  const beat = readRepairerBeat();
  return beat && now - Date.parse(beat.at) < 90_000 ? beat : undefined;
}

function bucketOf(id: string): { lane: Lane; bucket: 'queue' | 'active' | 'done' } | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const dirs = laneDirs(lane);
    if (fs.existsSync(path.join(dirs.queue, `${id}.json`))) return { lane, bucket: 'queue' };
    if (fs.existsSync(path.join(dirs.active, id))) return { lane, bucket: 'active' };
    if (fs.existsSync(path.join(dirs.done, id))) return { lane, bucket: 'done' };
  }
  return undefined;
}

function isTerminal(id: string): boolean {
  const bucket = bucketOf(id);
  if (!bucket) return true;
  return ['done', 'failed'].includes(reconcile({ log: readStatusLog(id, bucket.lane), lastEventAt: lastEventAt(id, bucket.lane) }));
}

/** The latest chain member and whether any member is queued or active. */
function chainState(owner: string): { latest: string; busy: boolean } {
  const dirs = laneDirs('work');
  const found: Array<{ descriptor: Descriptor; bucket: 'queue' | 'active' | 'done' }> = [];
  for (const bucket of ['queue', 'active', 'done'] as const) {
    let names: string[];
    try {
      names = fs.readdirSync(dirs[bucket]);
    } catch {
      continue;
    }
    for (const name of names) {
      if (bucket === 'queue' && !name.endsWith('.json')) continue;
      const id = bucket === 'queue' ? name.slice(0, -5) : name;
      const descriptor = storedDescriptor(id, 'work');
      if (descriptor) found.push({ descriptor, bucket });
    }
  }
  const chain = new Set([owner]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of found)
      if (row.descriptor.followUp && chain.has(row.descriptor.followUp) && !chain.has(row.descriptor.id)) {
        chain.add(row.descriptor.id);
        changed = true;
      }
  }
  const members = found.filter((row) => chain.has(row.descriptor.id));
  const byId = new Map(members.map((row) => [row.descriptor.id, row.descriptor]));
  const depth = (row: (typeof members)[number]): number => {
    let n = 0,
      at = row.descriptor.followUp;
    const seen = new Set<string>();
    while (at && byId.has(at) && !seen.has(at)) {
      seen.add(at);
      n++;
      at = byId.get(at)?.followUp;
    }
    return n;
  };
  const latest =
    members.sort((a, b) => depth(b) - depth(a) || (b.descriptor.queuedAt ?? '').localeCompare(a.descriptor.queuedAt ?? ''))[0]?.descriptor
      .id ?? owner;
  const busy = members.some((row) => row.bucket !== 'done' && !isTerminal(row.descriptor.id));
  return { latest, busy };
}

function repairOwnership(pr: PrRecord, w: Watch, latest: string): { safe: boolean; reason?: string } {
  const ids = new Set([...pr.dispatches, w.owner.slice('dispatch:'.length), latest, ...(w.lastFollowUpId ? [w.lastFollowUpId] : [])]);
  const knownShas = new Set<string>();
  for (const id of ids) {
    const bucket = bucketOf(id);
    if (bucket) for (const sha of readEvidence(id, bucket.lane).commits ?? []) knownShas.add(sha);
  }
  if ([...knownShas].some((sha) => pr.headSha.startsWith(sha.split(' ')[0]!))) return { safe: true };
  const ref = /^pr:([^/]+)\/([^#]+)#(\d+)$/.exec(pr.key);
  if (!ref) return { safe: false, reason: 'commit ownership unknown: invalid PR key' };
  const result = spawnSync('gh', ['api', `repos/${ref[1]}/${ref[2]}/pulls/${ref[3]}/commits?per_page=100`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return { safe: false, reason: 'commit ownership unknown: GitHub commits could not be read' };
  try {
    const commits = JSON.parse(result.stdout) as PrCommit[];
    if (!Array.isArray(commits) || commits.length >= 100 || commits.at(-1)?.sha !== pr.headSha) {
      return { safe: false, reason: 'commit ownership unknown: incomplete PR commit list' };
    }
    return branchOwnership(commits, knownShas);
  } catch {
    return { safe: false, reason: 'commit ownership unknown: invalid GitHub commit list' };
  }
}

/** Claim and enqueue a repair under the PR record lock, once per head and observation. */
export function deliverPrRepairs(log: (message: string) => void, cap = 3): number {
  const cfg = loadConfig().watch;
  if (!cfg.autoRepair) return 0;
  const limit = repairLimit(cfg.maxRepairsPerPr);
  const budget = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 3;
  let started = 0;
  for (const w of listWatches()) {
    if (started >= budget) break;
    if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:') || w.done || w.heldAt) continue;
    withPrLock(w.key, () => {
      const pr = readPr(w.key);
      if (!pr || pr.state !== 'OPEN' || pr.dispatches.length === 0 || (pr.observations ?? 0) <= 1) return;
      const kind = repairKind(pr);
      if (!kind || (kind === 'conflict' && !cfg.conflicts) || (kind === 'checks' && !cfg.checks)) return;
      const previous = pr.repair?.headSha === pr.headSha ? pr.repair : undefined;
      if (previous?.status === 'repairing' && previous.dispatchId && !isTerminal(previous.dispatchId)) return;
      if (previous?.status === 'blocked' || previous?.status === 'gave-up') return;
      if (previous?.observationsAtRepair !== undefined && (pr.observations ?? 0) <= previous.observationsAtRepair) return;
      const attempts = previous?.attempts ?? 0;
      if (attempts >= limit) {
        writePr({
          ...pr,
          repair: {
            headSha: pr.headSha,
            kind,
            attempts,
            maxAttempts: limit,
            status: 'gave-up',
            reason: `repair limit reached (${attempts} of ${limit})`,
          },
        });
        return;
      }
      const chain = chainState(w.owner.slice('dispatch:'.length));
      if (chain.busy) return;
      const ownership = repairOwnership(pr, w, chain.latest);
      if (!ownership.safe) {
        writePr({
          ...pr,
          repair: { headSha: pr.headSha, kind, attempts, maxAttempts: limit, status: 'blocked', reason: ownership.reason },
        });
        return;
      }
      const target = storedDescriptor(chain.latest, 'work');
      if (!target) return;
      const claim = readSessionClaim(chain.latest, 'work');
      const deliveredTo = readEvidence(chain.latest, 'work').deliveredTo;
      const address = claim?.by.startsWith('wt:') ? claim.by : deliveredTo?.startsWith('wt:') ? deliveredTo : undefined;
      const trap = address ? readTrap(address.slice(3)) : undefined;
      const id = randomUUID();
      writePr({
        ...pr,
        repair: {
          headSha: pr.headSha,
          kind,
          attempts: attempts + 1,
          maxAttempts: limit,
          status: 'repairing',
          dispatchId: id,
          observationsAtRepair: pr.observations,
          startedAt: new Date().toISOString(),
          by: 'daemon',
        },
      });
      try {
        enqueue({ id, repo: target.repo, brief: repairBrief(pr, kind), followUp: chain.latest, ...(trap ? { for: address } : {}) }, 'work');
        markFollowUp(w.key, id, readWatchEvents(w.key).length);
        started++;
        log(`repair ${w.key}: ${kind} -> ${id}${trap ? ` (addressed to ${address})` : ''}`);
      } catch (err) {
        writePr({
          ...pr,
          repair: {
            headSha: pr.headSha,
            kind,
            attempts,
            maxAttempts: limit,
            status: 'blocked',
            reason: `repair enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    });
  }
  return started;
}
