import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendWatchEvents,
  enqueue,
  holdWatch,
  laneDirs,
  loadConfig,
  lastEventAt,
  listWatches,
  markFollowUp,
  markWatchSeen,
  pendingWatchEvents,
  postNotice,
  readWatch,
  readWatchEvents,
  readStatusLog,
  readEvidence,
  readPr,
  reconcile,
  removeWatch,
  runWatchCheck,
  setWatchCursor,
  watchDue,
  watchFailureLogLine,
  writePr,
} from '@lobstah/core';
import { readSessionClaim, readTrap } from '@lobstah/core';
import type { Descriptor, Lane, PrRecord, Watch, WatchEvent } from '@lobstah/core';
import type { ReportNotification } from './report.js';

const DEFAULT_BRIEF = `You are resuming earlier work. The watched source {key} produced new events:

{events}

Read them, act on what they ask, and report the outcome.`;

function laneOf(id: string): Lane | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    if (
      fs.existsSync(path.join(d.active, id)) ||
      fs.existsSync(path.join(d.queue, `${id}.json`)) ||
      fs.existsSync(path.join(d.done, id)) ||
      fs.existsSync(path.join(d.state, `${id}.status`))
    ) {
      return lane;
    }
  }
  return undefined;
}

function descriptorOf(id: string, lane: Lane): Descriptor | undefined {
  const d = laneDirs(lane);
  for (const bucket of ['active', 'done'] as const) {
    const f = path.join(d[bucket], id, 'descriptor.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) as Descriptor;
  }
  const q = path.join(d.queue, `${id}.json`);
  if (fs.existsSync(q)) return JSON.parse(fs.readFileSync(q, 'utf8')) as Descriptor;
  return undefined;
}

function isTerminal(id: string): boolean {
  const lane = laneOf(id);
  if (!lane) return true; // culled or never spawned — nothing to collide with
  const state = reconcile({ log: readStatusLog(id, lane), lastEventAt: lastEventAt(id, lane) });
  return state === 'done' || state === 'failed';
}

/**
 * Fork a continuation of a dispatch-owned watch: a fresh dispatch that resumes
 * the latest session in the chain with the buffered events as its brief. One
 * continuation in flight per watch — further events buffer until it finishes.
 */
function spawnContinuation(w: Watch, pending: WatchEvent[], log: (m: string) => void, fixedBrief?: string, targetOverride?: string): string | undefined {
  const owner = w.owner.slice('dispatch:'.length);
  const target = targetOverride ?? (w.lastFollowUpId && !laneOf(w.lastFollowUpId) ? owner : (w.lastFollowUpId ?? owner));
  const targetLane = laneOf(target);
  if (!targetLane) {
    log(`watch ${w.key}: owner dispatch ${target} is gone — dropping watch`);
    removeWatch(w.key);
    return undefined;
  }
  const descriptor = descriptorOf(target, targetLane);
  if (!descriptor) {
    log(`watch ${w.key}: no descriptor for ${target} — dropping watch`);
    removeWatch(w.key);
    return undefined;
  }
  const id = randomUUID();
  const brief = (fixedBrief ?? w.brief ?? DEFAULT_BRIEF)
    .replaceAll('{key}', w.key)
    .replaceAll('{summaries}', pending.map((e) => `- ${e.summary ?? `event ${String(e.seq)}`}`).join('\n'))
    .replaceAll('{events}', JSON.stringify(pending, null, 2));
  // A chain worked by a live trap gets its continuation addressed there —
  // the trap picks it up at its next park instead of a headless fork
  // running beside it. Addressed bait is sticky: if the trap ghosts, the
  // orphan surfaces as a helm notice rather than falling to the daemon.
  const claim = readSessionClaim(target, targetLane);
  const deliveredTo = readEvidence(target, targetLane).deliveredTo;
  const trapAddress = claim?.by.startsWith('wt:') ? claim.by : deliveredTo?.startsWith('wt:') ? deliveredTo : undefined;
  const claimant = trapAddress?.slice('wt:'.length);
  const live = claimant !== undefined && readTrap(claimant) !== undefined;
  enqueue(
    { id, repo: descriptor.repo, brief, followUp: target, ...(live ? { for: trapAddress } : {}) },
    'work',
  );
  markFollowUp(w.key, id, readWatchEvents(w.key).length);
  log(
    `watch ${w.key}: ${pending.length} event(s) → continuation ${id} ` +
      (live ? `(addressed to soaking ${claimant!.slice(0, 8)})` : `(forks ${target})`),
  );
  return id;
}

/** [watch].maxForksPerCycle; a bad value falls back to the default of 3. */
function maxForksPerCycle(): number {
  try {
    const n = Number(loadConfig().watch.maxForksPerCycle);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
  } catch {
    return 3;
  }
}

type RepairKind = 'conflict' | 'checks' | 'review';
type PrCommit = { sha?: string; author?: { login?: string } | null; committer?: { login?: string } | null; commit?: { author?: { email?: string }; committer?: { email?: string } } };

/** A known dispatch commit anchors identity; later PR commits must have the same author AND committer. */
export function branchOwnership(commits: PrCommit[], knownShas: ReadonlySet<string>): { safe: boolean; reason?: string } {
  let lastKnown = -1;
  commits.forEach((c, i) => { if (c.sha && [...knownShas].some((sha) => c.sha!.startsWith(sha.split(' ')[0]!))) lastKnown = i; });
  if (lastKnown < 0) return { safe: false, reason: 'commit ownership unknown: no dispatch commit on the PR branch' };
  const identity = (c: PrCommit) => [c.author?.login ?? c.commit?.author?.email ?? '', c.committer?.login ?? c.commit?.committer?.email ?? ''];
  const owner = identity(commits[lastKnown]!);
  if (owner.some((x) => !x)) return { safe: false, reason: 'commit ownership unknown: dispatch identity missing' };
  for (const commit of commits.slice(lastKnown + 1)) {
    const current = identity(commit);
    if (current.some((x) => !x)) return { safe: false, reason: 'commit ownership unknown: newer commit identity missing' };
    if (current[0] !== owner[0] || current[1] !== owner[1]) return { safe: false, reason: 'person commits since the last lobstah commit' };
  }
  return { safe: true };
}

function repairOwnership(pr: PrRecord, w: Watch, latest: string): { safe: boolean; reason?: string } {
  const ids = new Set([...pr.dispatches, w.owner.slice('dispatch:'.length), latest, ...(w.lastFollowUpId ? [w.lastFollowUpId] : [])]);
  const knownShas = new Set<string>();
  for (const id of ids) {
    const lane = laneOf(id);
    if (lane) for (const sha of readEvidence(id, lane).commits ?? []) knownShas.add(sha);
  }
  if ([...knownShas].some((sha) => pr.headSha.startsWith(sha.split(' ')[0]!))) return { safe: true };
  const ref = /^pr:([^/]+)\/([^#]+)#(\d+)$/.exec(pr.key);
  if (!ref) return { safe: false, reason: 'commit ownership unknown: invalid PR key' };
  const result = spawnSync('gh', ['api', `repos/${ref[1]}/${ref[2]}/pulls/${ref[3]}/commits?per_page=100`], { encoding: 'utf8', timeout: 60_000 });
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

function repairKind(pr: PrRecord): RepairKind | undefined {
  if (pr.mergeStateStatus === 'DIRTY') return 'conflict';
  if (pr.checks.failed > 0) return 'checks';
  if (pr.review?.changesRequested) return 'review';
  return undefined;
}

/** Find the newest chain member and any queued/active member, including manual follow-ups. */
function chainState(owner: string): { latest: string; busy: boolean } {
  const dirs = laneDirs('work');
  const found: Array<{ descriptor: Descriptor; bucket: 'queue' | 'active' | 'done' }> = [];
  for (const bucket of ['queue', 'active', 'done'] as const) {
    let names: string[];
    try { names = fs.readdirSync(dirs[bucket]); } catch { continue; }
    for (const name of names) {
      const id = bucket === 'queue' ? name.replace(/\.json$/, '') : name;
      if (bucket === 'queue' && !name.endsWith('.json')) continue;
      const descriptor = descriptorOf(id, 'work');
      if (descriptor) found.push({ descriptor, bucket });
    }
  }
  const chain = new Set([owner]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of found) if (row.descriptor.followUp && chain.has(row.descriptor.followUp) && !chain.has(row.descriptor.id)) {
      chain.add(row.descriptor.id);
      changed = true;
    }
  }
  const members = found.filter((row) => chain.has(row.descriptor.id));
  const byId = new Map(members.map((row) => [row.descriptor.id, row.descriptor]));
  const depth = (row: (typeof members)[number]): number => {
    let n = 0, at = row.descriptor.followUp;
    const seen = new Set<string>();
    while (at && byId.has(at) && !seen.has(at)) { seen.add(at); n++; at = byId.get(at)?.followUp; }
    return n;
  };
  const latest = members.sort((a, b) => depth(b) - depth(a) || (b.descriptor.queuedAt ?? '').localeCompare(a.descriptor.queuedAt ?? ''))[0]?.descriptor.id ?? owner;
  const busy = members.some((row) => row.bucket !== 'done' && !isTerminal(row.descriptor.id));
  return { latest, busy };
}

/** The repair prompt uses the PR's actual base branch, including stacked PRs. */
export function repairBrief(pr: PrRecord, kind: RepairKind): string {
  const intro = `Repair ${pr.url} on its existing branch ${pr.headRefName ?? '(see PR)'} at ${pr.headSha}. Do not open a new PR.`;
  const finish = `Run the relevant tests. Push the PR branch and report done with the same PR URL.`;
  if (kind === 'conflict') return `${intro}\nFetch the PR's base branch ${pr.baseRefName ?? '(read from PR)'}. Bring the PR branch up to date with that base by this repo's convention. Resolve conflicts while keeping both sides' intent. Push with --force-with-lease only if you rebased. ${finish}`;
  if (kind === 'checks') {
    const checks = (pr.failingChecks ?? []).map((c) => `- ${c.name}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`).join('\n');
    return `${intro}\nLatest failing checks:\n${checks || '- Read the failing check from GitHub'}\nRead each check log. Fix a real failure. If it is a flake, rerun it at most once. ${finish}`;
  }
  return `${intro}\nRead the requested review changes and comments with gh pr view --comments. Address the feedback. If a comment needs a person's decision, report needs-decision instead of guessing. ${finish}`;
}

/** Schedule at most `cap` PR repairs before generic watch continuations use the rest of the cycle budget. */
export function deliverPrRepairs(log: (m: string) => void, cap: number): number {
  const cfg = loadConfig().watch;
  if (!cfg.autoRepair) return 0;
  let forks = 0;
  const limit = Number.isFinite(cfg.maxRepairsPerPr) && cfg.maxRepairsPerPr >= 0 ? Math.floor(cfg.maxRepairsPerPr) : 2;
  for (const w of listWatches()) {
    if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:') || w.done || w.heldAt) continue;
    const pr = readPr(w.key);
    if (!pr || pr.state !== 'OPEN' || pr.dispatches.length === 0) continue;
    const kind = repairKind(pr);
    if (!kind || (kind === 'conflict' && !cfg.conflicts) || (kind === 'checks' && !cfg.checks)) continue;
    if ((pr.observations ?? 0) <= 1) continue; // first sight is a baseline
    const previous = pr.repair?.headSha === pr.headSha ? pr.repair : undefined;
    if (previous?.status === 'repairing' && previous.dispatchId && !isTerminal(previous.dispatchId)) continue;
    if (previous?.status === 'blocked' || previous?.status === 'gave-up') continue;
    if (previous?.observationsAtRepair !== undefined && (pr.observations ?? 0) <= previous.observationsAtRepair) continue;
    const attempts = previous?.attempts ?? 0;
    if (attempts >= limit) {
      writePr({ ...pr, repair: { headSha: pr.headSha, kind, attempts, maxAttempts: limit, status: 'gave-up', reason: `repair limit reached (${attempts} of ${limit})` } });
      continue;
    }
    const chain = chainState(w.owner.slice('dispatch:'.length));
    if (chain.busy) continue; // the chain already has work queued or active
    const ownership = repairOwnership(pr, w, chain.latest);
    if (!ownership.safe) {
      writePr({ ...pr, repair: { headSha: pr.headSha, kind, attempts, maxAttempts: limit, status: 'blocked', reason: ownership.reason } });
      continue;
    }
    if (forks >= cap) continue;
    const id = spawnContinuation(w, [], log, repairBrief(pr, kind), chain.latest);
    if (!id) continue;
    writePr({ ...pr, repair: { headSha: pr.headSha, kind, attempts: attempts + 1, maxAttempts: limit, status: 'repairing', dispatchId: id, observationsAtRepair: pr.observations } });
    forks++;
  }
  return forks;
}

function notifyMan(watch: Watch, fresh: WatchEvent[], notify: (n: ReportNotification) => void): void {
  if (fresh.length === 0 || watch.owner !== 'man') return;
  notify({
    key: watch.key,
    uuid: 'watch',
    verb: 'watch',
    note: fresh[0]?.summary ?? `${fresh.length} new event(s)`,
  });
}

/**
 * Fork continuations for buffered dispatch-owned events, retire spent
 * watches. One call is one cycle, and it forks at most
 * [watch].maxForksPerCycle continuations. Each watch over the cap is held:
 * its events stay buffered, tend lists it as held, one notice names it, and
 * it forks nothing until `lobstah watch release`. A held watch is skipped.
 */
export function deliverDispatchOwned(log: (m: string) => void, cap = maxForksPerCycle()): void {
  let forks = deliverPrRepairs(log, cap);
  const autoRepair = loadConfig().watch.autoRepair;
  const held: string[] = [];
  for (const { watch, events } of pendingWatchEvents(false, 'dispatch')) {
    if (autoRepair && watch.key.startsWith('pr:') && readPr(watch.key)) {
      markWatchSeen(watch.key);
      continue;
    }
    if (watch.heldAt) continue; // waits for `lobstah watch release`
    if (watch.lastFollowUpId && !isTerminal(watch.lastFollowUpId)) continue; // one continuation in flight
    if (forks >= cap) {
      holdWatch(watch.key);
      held.push(watch.key);
      continue;
    }
    if (spawnContinuation(watch, events, log)) forks++;
  }
  if (held.length > 0) {
    log(`watch: fork cap ${cap} reached — held ${held.join(', ')}`);
    postNotice({
      kind: 'watch-held',
      text: `watch cycle reached its fork cap (${cap}); held ${held.length}: ${held.join(', ')} — \`lobstah watch release <key>\` or \`--all\` to let them fork`,
      refId: held[0],
    });
  }
  // A retired source with nothing left to deliver has spent its purpose.
  for (const w of listWatches()) {
    if (w.done && w.owner !== 'man' && readWatchEvents(w.key).length <= w.seen) removeWatch(w.key);
  }
}

/**
 * The watch loop: run due checks, then deliver. Man-owned events just land in
 * the events file — `man wait`/`man haul` surface them — plus one notify ping
 * per batch. Dispatch-owned events fork a continuation of the owning chain.
 */
export async function watchLoop(
  defaultEverySecs: number,
  log: (m: string) => void,
  notify: (n: ReportNotification) => void = () => {},
): Promise<void> {
  for (const w of listWatches()) {
    if (watchDue(w, defaultEverySecs)) {
      const { watch, fresh } = runWatchCheck(w);
      if (watch.lastError) log(watchFailureLogLine(watch));
      notifyMan(watch, fresh, notify);
    }
  }
  deliverDispatchOwned(log);
}

/**
 * One NDJSON line from a watch's held stream: either a bare cursor
 * checkpoint or an event object. Events append seq-deduped (the cadence
 * check remains the guarantee and may see the same event) and deliver
 * immediately — this is the whole point of the stream.
 */
export function handleStreamLine(key: string, line: string, log: (m: string) => void, notify: (n: ReportNotification) => void): void {
  const watch = readWatch(key);
  if (!watch) return; // removed while streaming — the manager reaps the child
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    log(`watch ${key}: unparseable stream line — ${line.slice(0, 120)}`);
    return;
  }
  if (parsed.seq === undefined) {
    if (parsed.cursor !== undefined) setWatchCursor(key, String(parsed.cursor));
    return;
  }
  const event: WatchEvent = {
    seq: parsed.seq as number | string,
    summary: parsed.summary !== undefined ? String(parsed.summary) : undefined,
    ...parsed,
    at: new Date().toISOString(),
  };
  const fresh = appendWatchEvents(key, event.seq !== undefined ? [event] : []);
  setWatchCursor(key, String(parsed.cursor ?? event.seq));
  notifyMan(watch, fresh, notify);
  if (fresh.length > 0) deliverDispatchOwned(log);
}
