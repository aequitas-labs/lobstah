import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  branchOwnership,
  chainPr,
  enqueue,
  laneDirs,
  lastEventAt,
  listWatches,
  loadConfig,
  lobstahHome,
  holdWatch,
  failingCheckNames,
  humanGatesFor,
  latestCheckOutcomes,
  matchesGate,
  markFollowUp,
  mergeEvidence,
  parsePrRef,
  postNotice,
  PUSH_REJECTED,
  readEvidence,
  readPr,
  readPrs,
  readSessionClaim,
  readStatusLog,
  readTrap,
  readWatchEvents,
  recordHumanGates,
  reconcile,
  releaseHeldWatches,
  repairBrief,
  repairKind,
  repairLimit,
  repairableChecks,
  storedDescriptor,
  unrepairedChecks,
  withPrLock,
  writePr,
} from '@lobstah/core';
import type { Descriptor, GhPrView, Lane, Outcome, PrCommit, PrRecord, PrRepair, Watch } from '@lobstah/core';
import { readWorkerHolds, repairHold } from './repair-holds.js';
import type { RepairHold, WorkerHold } from './repair-holds.js';

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

/** The latest run of each check on the PR's current head. */
export interface LatestChecks {
  headSha: string;
  checks: Array<{ name: string; outcome: Outcome }>;
}

/** One `gh pr view` for the head and the check runs only. Undefined when it cannot be read. */
export function ghLatestChecks(pr: PrRecord): LatestChecks | undefined {
  const ref = parsePrRef(pr.key);
  if (!ref) return undefined;
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', 'headRefOid,statusCheckRollup'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (res.error || res.status !== 0) return undefined;
  try {
    const view = JSON.parse(res.stdout) as Pick<GhPrView, 'headRefOid' | 'statusCheckRollup'>;
    return typeof view.headRefOid === 'string' ? { headSha: view.headRefOid, checks: latestCheckOutcomes(view.statusCheckRollup) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the failing checks again. A check is still failing only when a latest
 * run with its name failed. Returns why no repair is due, or undefined when
 * the checks still fail.
 */
export function checksStillFailing(
  pr: PrRecord,
  latest: LatestChecks | undefined,
  names: readonly string[] = (pr.failingChecks ?? []).map((c) => c.name),
): string | undefined {
  if (!latest) return 'the latest check runs could not be read';
  if (latest.headSha !== pr.headSha) return `the head moved to ${latest.headSha.slice(0, 7)}; waiting for the next observation`;
  let failing = 0;
  for (const name of names) {
    const runs = latest.checks.filter((c) => c.name === name);
    if (runs.some((c) => c.outcome === 'failed')) {
      failing++;
      continue;
    }
    if (runs.some((c) => c.outcome === 'pending')) return `the latest run of ${name} is in progress`;
    if (runs.length > 0 && runs.every((c) => c.outcome === 'passed')) return `the latest run of ${name} passed`;
  }
  return failing > 0 || names.length === 0 ? undefined : 'no failing check on the latest runs';
}

export interface RepairOptions {
  now?: number;
  /** Read the latest check runs of a PR before a checks repair (default: gh). */
  readChecks?: (pr: PrRecord) => LatestChecks | undefined;
  /** Live workers and what they hold (default: read from disk and git). */
  workerHolds?: () => WorkerHold[];
}

/** The watch hold on a PR, as the PR record shows it. */
function watchHold(w: Watch): RepairHold {
  const heldBy = w.heldBy ?? (w.heldFor ? `dispatch:${w.heldFor.slice(0, 8)}` : 'hold');
  const reason = w.heldReason ?? `held since ${w.heldAt}`;
  return { heldBy, reason: `${reason}; \`lobstah watch release ${w.key}\` frees it` };
}

/**
 * When the helm cancels a repair dispatch, hold its PR's watch: no new
 * repair is queued for that PR until `lobstah watch release`. Returns the
 * held keys.
 */
export function holdCancelledRepair(id: string, now = new Date()): string[] {
  const held: string[] = [];
  for (const pr of readPrs()) {
    if (pr.repair?.dispatchId !== id) continue;
    if (holdWatch(pr.key, now, { reason: `the helm cancelled repair ${id.slice(0, 8)}`, by: 'helm' })) held.push(pr.key);
  }
  return held;
}

/**
 * Claim and enqueue a repair under the PR record lock, once per head and
 * observation. A repair that is due but must not start yet is recorded as
 * `waiting` with the reason: the watch is held, a live worker holds the PR
 * or a PR below it, the PR has not settled, or the failing checks no longer
 * fail. A wait is not an attempt.
 */
export function deliverPrRepairs(log: (message: string) => void, cap = 3, opts: RepairOptions = {}): number {
  const cfg = loadConfig().watch;
  if (!cfg.autoRepair) return 0;
  const now = opts.now ?? Date.now();
  const limit = repairLimit(cfg.maxRepairsPerPr);
  const settleMs = Math.max(0, Number.isFinite(cfg.repairSettleSecs) ? cfg.repairSettleSecs : 600) * 1000;
  const budget = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 3;
  let workers: WorkerHold[] | undefined;
  let records: PrRecord[] | undefined;
  let started = 0;
  for (let w of listWatches()) {
    if (started >= budget) break;
    if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:') || w.done) continue;
    // A hold for one dispatch ends when that dispatch ends.
    if (w.heldAt && w.heldFor && isTerminal(w.heldFor)) {
      releaseHeldWatches(w.key);
      log(`repair ${w.key}: hold ended with dispatch ${w.heldFor.slice(0, 8)}`);
      w = { ...w, heldAt: undefined, heldReason: undefined, heldFor: undefined, heldBy: undefined };
    }
    const watch = w;
    withPrLock(watch.key, () => {
      const pr = readPr(watch.key);
      if (!pr || pr.state !== 'OPEN' || pr.dispatches.length === 0 || (pr.observations ?? 0) <= 1) return;
      // A repair's stray PR must not become a second repair chain. Its
      // ancestor chain already owns a different PR.
      const owner = watch.owner.slice('dispatch:'.length);
      const origin = storedDescriptor(owner, 'work')?.followUp;
      const ancestorPr = origin && chainPr(origin, 'work');
      if (ancestorPr && ancestorPr.url !== pr.url) return;
      // A failed push marks the moved head and still covers the head it started from.
      const previous = pr.repair && (pr.repair.headSha === pr.headSha || pr.repair.fromHeadSha === pr.headSha) ? pr.repair : undefined;
      // Human gates: the repo's list, the PR record's, and what the chain's workers named.
      const gates = humanGatesFor(pr, storedDescriptor(owner, 'work')?.repo, [
        ...pr.dispatches,
        owner,
        ...(watch.lastFollowUpId ? [watch.lastFollowUpId] : []),
        ...(pr.repair?.dispatchId ? [pr.repair.dispatchId] : []),
      ]);
      const kind = repairKind(pr, gates);
      const repairable = kind === 'checks' ? repairableChecks(pr, gates) : [];
      const attempts = previous?.attempts ?? 0;
      // A PR whose only failing checks are human gates waits for a person. It is not a repair.
      const gated = !kind && cfg.checks ? failingCheckNames(pr).filter((name) => matchesGate(name, gates)) : [];
      if (gated.length > 0) {
        if (previous?.status === 'repairing' && previous.dispatchId && !isTerminal(previous.dispatchId)) return;
        const reason = `human gate: ${gated.join(', ')} passes only when a person approves`;
        if (previous?.status === 'waiting' && previous.heldBy === 'human-gate' && previous.reason === reason) return;
        const { until: _until, ...rest } = previous ?? { headSha: pr.headSha, kind: 'checks' as const, attempts };
        writePr({ ...pr, repair: { ...rest, headSha: pr.headSha, kind: 'checks', attempts, maxAttempts: limit, status: 'waiting', heldBy: 'human-gate', reason } });
        return;
      }
      if (!kind || (kind === 'conflict' && !cfg.conflicts) || (kind === 'checks' && !cfg.checks)) {
        // Nothing to repair: a wait from before ends.
        if (previous?.status === 'waiting') writePr({ ...pr, repair: endWait(previous) });
        return;
      }
      if (previous?.status === 'repairing' && previous.dispatchId && !isTerminal(previous.dispatchId)) return;
      if (previous?.status === 'blocked' || previous?.status === 'gave-up') return;
      if (previous?.observationsAtRepair !== undefined && (pr.observations ?? 0) <= previous.observationsAtRepair) return;
      // The floor: one round per PR, check, and commit. A head that has not
      // moved cannot give a check a new outcome.
      const fresh = unrepairedChecks(repairable, previous?.checks);
      if (previous && repairable.length > 0 && fresh.length === 0) {
        const reason = `one repair round per check and commit: ${repairable.join(', ')} had a round at ${pr.headSha.slice(0, 7)}; waits for a new commit`;
        if (previous.status === 'waiting' && previous.heldBy === 'repaired' && previous.reason === reason) return;
        const { until: _until, ...rest } = previous;
        writePr({ ...pr, repair: { ...rest, kind, status: 'waiting', heldBy: 'repaired', reason } });
        return;
      }
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
      const wait = (hold: RepairHold, until?: string): void => {
        if (previous?.status === 'waiting' && previous.kind === kind && previous.heldBy === hold.heldBy &&
          previous.reason === hold.reason && previous.until === until) return;
        writePr({
          ...pr,
          repair: {
            ...(previous?.dispatchId ? { dispatchId: previous.dispatchId } : {}),
            ...(previous?.observationsAtRepair !== undefined ? { observationsAtRepair: previous.observationsAtRepair } : {}),
            ...(previous?.checks ? { checks: previous.checks } : {}),
            headSha: pr.headSha,
            kind,
            attempts,
            maxAttempts: limit,
            status: 'waiting',
            heldBy: hold.heldBy,
            reason: hold.reason,
            ...(until ? { until } : {}),
          },
        });
      };
      if (watch.heldAt) return wait(watchHold(watch));
      const held = repairHold(pr, (records ??= readPrs()), (workers ??= (opts.workerHolds ?? readWorkerHolds)()));
      if (held) return wait(held);
      const changed = Math.max(
        Date.parse(pr.headSince ?? pr.observedAt) || now,
        Date.parse(pr.baseSince ?? pr.observedAt) || now,
        kind === 'checks' ? Date.parse(pr.failingSince ?? pr.observedAt) || now : 0,
      );
      if (now < changed + settleMs) {
        const until = new Date(changed + settleMs).toISOString();
        return wait({ heldBy: 'settle', reason: `settling: the head, base, or failing checks changed at ${new Date(changed).toISOString()}` }, until);
      }
      const chain = chainState(owner);
      if (chain.busy) return;
      if (kind === 'checks') {
        const why = checksStillFailing(pr, (opts.readChecks ?? ghLatestChecks)(pr), repairable.length > 0 ? fresh : undefined);
        if (why) return wait({ heldBy: 'checks', reason: why });
      }
      const ownership = repairOwnership(pr, watch, chain.latest);
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
          ...(fresh.length > 0 || previous?.checks ? { checks: [...(previous?.checks ?? []), ...fresh] } : {}),
          observationsAtRepair: pr.observations,
          startedAt: new Date(now).toISOString(),
          by: 'daemon',
        },
      });
      try {
        const brief = repairBrief(pr, kind, kind === 'checks' && fresh.length > 0 ? { id, checks: fresh, gates } : { id, gates });
        enqueue({
          id,
          repo: target.repo,
          brief,
          followUp: chain.latest,
          pr: { url: pr.url, headRefName: pr.headRefName, headSha: pr.headSha },
          ...(trap ? { for: address } : {}),
        }, 'work');
        mergeEvidence(id, 'work', { prUrl: pr.url, pr });
        markFollowUp(watch.key, id, readWatchEvents(watch.key).length);
        started++;
        log(`repair ${watch.key}: ${kind} -> ${id}${trap ? ` (addressed to ${address})` : ''}`);
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

/**
 * `report --human-gate <check>`: the worker names checks that pass only
 * when a person approves. The names go into its evidence and onto the PR
 * record of its PR (`--pr`, else its evidence, else its chain's PR), so the
 * repairer and pickup skip them on that PR. Returns the names recorded.
 */
export function recordReportedGates(id: string, lane: Lane, names: readonly string[], prUrl?: string): string[] {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (clean.length === 0) return [];
  const evidence = readEvidence(id, lane);
  mergeEvidence(id, lane, { humanGates: [...new Set([...(evidence.humanGates ?? []), ...clean])] });
  const url = prUrl ?? evidence.prUrl ?? evidence.pr?.url ?? chainPr(id, lane)?.url;
  const ref = url ? parsePrRef(url) : undefined;
  if (ref) recordHumanGates(ref.key, clean);
  return clean;
}

/** A wait that ends with nothing to repair: the record before the wait. */
function endWait(previous: PrRepair): PrRepair | undefined {
  if (!previous.dispatchId) return undefined;
  const { heldBy: _heldBy, until: _until, reason: _reason, ...rest } = previous;
  return { ...rest, status: 'repairing' };
}

/** PRs whose repair waits, for tend, the glass, and doctor. */
export function waitingRepairs(records: readonly PrRecord[] = readPrs()): PrRecord[] {
  return records.filter((pr) => pr.state === 'OPEN' && pr.repair?.status === 'waiting' && pr.repair.headSha === pr.headSha);
}

/**
 * A worker on an existing PR reported `failed "push rejected: ..."`: it
 * could not push to the PR's branch. Mark the PR's repair `blocked` at the
 * moved head named in the note (and at the head it started from, until the
 * watch observes the move), so no repair starts on that head, and post a
 * `push-failed` notice. The PR itself is not touched. Returns the PR key,
 * or undefined when the report is not a push failure of a PR-bound dispatch.
 */
export function recordPushFailure(id: string, lane: Lane, note: string | undefined): string | undefined {
  if (!note || !note.trim().toLowerCase().startsWith(PUSH_REJECTED)) return undefined;
  const descriptor = storedDescriptor(id, lane);
  if (!descriptor) return undefined;
  const url = descriptor.pr?.url ?? (descriptor.followUp ? chainPr(descriptor.followUp, lane)?.url : undefined);
  const ref = url ? parsePrRef(url) : undefined;
  if (!ref) return undefined;
  const moved = /\b[0-9a-f]{40}\b/.exec(note)?.[0];
  const reason = `push failed (dispatch ${id.slice(0, 8)}): ${note.trim().slice(0, 300)}`;
  withPrLock(ref.key, () => {
    const pr = readPr(ref.key);
    if (!pr) return;
    const head = moved ?? pr.headSha;
    writePr({
      ...pr,
      repair: {
        headSha: head,
        ...(head !== pr.headSha ? { fromHeadSha: pr.headSha } : {}),
        kind: pr.repair?.kind ?? repairKind(pr) ?? 'conflict',
        attempts: pr.repair?.attempts ?? 1,
        ...(pr.repair?.maxAttempts !== undefined ? { maxAttempts: pr.repair.maxAttempts } : {}),
        status: 'blocked',
        reason,
        dispatchId: id,
      },
    });
  });
  postNotice({
    kind: 'push-failed',
    text: `${ref.url}: dispatch ${id.slice(0, 8)} could not push${moved ? `; moved head ${moved.slice(0, 12)}` : ''}. The PR is left as it was.`,
    refId: id,
    repo: descriptor.repo,
    dedupeKey: `push-failed-${id}`,
  });
  return ref.key;
}
