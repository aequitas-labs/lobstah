import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  appendWatchEvents,
  sendMessageOnce,
  builtinWatchRegistry,
  WatchAutomationRunner,
  WatchJournal,
  WatchRuntime,
  syncWatchSubscriptions,
  claimCommandWatchContinuation,
  reservedWatchDispatch,
  watchInstructionLines,
  planWatchDispatch,
  prepareWatchBrief,
  completeWatchDispatch,
  storedDescriptor,
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
  reconcile,
  removeWatch,
  setWatchCursor,
  watchFailureLogLine,
  runWatchCycle,
} from '@lobstah/core';
import { readSessionClaim, readTrap } from '@lobstah/core';
import type { WatchDispatchPlan, WatchRegistry } from '@lobstah/watch-types';
import type { Descriptor, Lane, Watch, WatchEvent } from '@lobstah/core';
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
function spawnContinuation(
  w: Watch,
  pending: WatchEvent[],
  log: (m: string) => void,
  fixedBrief?: string,
  targetOverride?: string,
  registry?: WatchRegistry,
  plan?: WatchDispatchPlan,
): string | undefined {
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
  const reservation = claimCommandWatchContinuation(w.key, pending, plan);
  if (!reservation) return undefined;
  const id = reservation.id;
  const deliveredThrough = reservation?.deliveredThrough ?? readWatchEvents(w.key).length;
  if (storedDescriptor(id, 'work')) {
    if (plan) completeWatchDispatch(w, pending, reservation.plan ?? plan, id, registry);
    markFollowUp(w.key, id, deliveredThrough);
    return id;
  }
  const supplied = !w.check && w.presentation ? [...watchInstructionLines(w.presentation, 'worker'), '', 'Watched events:', '{events}'].join('\n') : DEFAULT_BRIEF;
  const filled = (fixedBrief ?? w.brief ?? supplied)
    .replaceAll('{key}', w.key)
    .replaceAll('{summaries}', pending.map((e) => `- ${e.summary ?? `event ${String(e.seq)}`}`).join('\n'))
    .replaceAll('{events}', JSON.stringify(pending, null, 2));
  // Each adapter supplies its own repository instructions.
  const brief = prepareWatchBrief(w, pending, filled, descriptor.repo, registry);
  // A chain worked by a live trap gets its continuation addressed there —
  // the trap picks it up at its next park instead of a headless fork
  // running beside it. Addressed bait is sticky: if the trap ghosts, the
  // orphan surfaces as a helm notice rather than falling to the daemon.
  const claim = readSessionClaim(target, targetLane);
  const deliveredTo = readEvidence(target, targetLane).deliveredTo;
  const trapAddress = claim?.by.startsWith('wt:') ? claim.by : deliveredTo?.startsWith('wt:') ? deliveredTo : undefined;
  const claimant = trapAddress?.slice('wt:'.length);
  const live = claimant !== undefined && readTrap(claimant) !== undefined;
  enqueue({ id, repo: descriptor.repo, brief, followUp: target, ...(live ? { for: trapAddress } : {}) }, 'work');
  if (plan) completeWatchDispatch(w, pending, reservation.plan ?? plan, id, registry);
  markFollowUp(w.key, id, deliveredThrough);
  log(
    `watch ${w.key}: ${pending.length} event(s) → continuation ${id} ` +
      (live ? `(addressed to soaking ${claimant!.slice(0, 8)})` : `(forks ${target})`),
  );
  return id;
}

/**
 * The events of a PR watch that may start a CI-fix continuation. A failed
 * check that is a human gate (the repo's `humanGateChecks`, the PR record's
 * gates, or a gate the chain's workers named) starts nothing. Neither does a
 * check that already had its one round at this head. Returns the events to
 * deliver and the rounds they take.
 */
export { ciFixWork } from '@lobstah/core';

/** [watch].maxForksPerCycle; a bad value falls back to the default of 3. */
function maxForksPerCycle(): number {
  try {
    const n = Number(loadConfig().watch.maxForksPerCycle);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
  } catch {
    return 3;
  }
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
export function deliverDispatchOwned(log: (m: string) => void, cap = maxForksPerCycle(), registry?: WatchRegistry): void {
  // Sources may delegate managed work to their configured action handlers.
  let forks = 0;
  const held: string[] = [];
  for (const { watch, events } of pendingWatchEvents(false, 'dispatch')) {
    const plan = reservedWatchDispatch(watch.key)?.plan ?? planWatchDispatch(watch, events, undefined, registry);
    if (plan.disposition === 'managed') { markWatchSeen(watch.key); continue; }
    if (watch.heldAt) continue; // waits for `lobstah watch release`
    const selected = new Set(plan.eventIds);
    const work = plan.disposition === 'ignore' ? [] : events.filter((event) => selected.has(String(event.seq)));
    const skipped = plan.notes;
    if (work.length === 0) {
      markWatchSeen(watch.key);
      log(`watch ${watch.key}: no continuation for ${skipped.join(', ')}`);
      continue;
    }
    const owner = watch.owner.slice('dispatch:'.length);
    const target = watch.lastFollowUpId && laneOf(watch.lastFollowUpId) ? watch.lastFollowUpId : owner;
    const lane = laneOf(target);
    if (lane && readStatusLog(target, lane).length && !isTerminal(target)) {
      // One stable receipt per sequence also survives a crash followed by a larger feedback batch.
      for (const event of work) {
        const filled = (watch.brief ?? DEFAULT_BRIEF).replaceAll('{key}', watch.key)
          .replaceAll('{summaries}', `- ${event.summary ?? String(event.seq)}`)
          .replaceAll('{events}', JSON.stringify([event], null, 2));
        const text = prepareWatchBrief(watch, [event], filled, descriptorOf(target, lane)?.repo, registry);
        const receipt = createHash('sha256').update(JSON.stringify([watch.key, watch.generation ?? watch.createdAt, String(event.seq)])).digest('hex');
        sendMessageOnce(target, lane, receipt, text, `watch:${watch.key}`);
      }
      markWatchSeen(watch.key);
      log(`watch ${watch.key}: ${work.length} event(s) → inbox ${target}`);
      continue;
    }
    if (watch.lastFollowUpId && !isTerminal(watch.lastFollowUpId)) continue; // queued continuation owns this tail
    if (forks >= cap) {
      holdWatch(watch.key, new Date(), { reason: 'fork cap reached ([watch].maxForksPerCycle)' });
      held.push(watch.key);
      continue;
    }
    const workId = spawnContinuation(watch, work, log, undefined, undefined, registry, plan);
    if (workId) {
      forks++;
    }
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
  registry: WatchRegistry = builtinWatchRegistry(),
): Promise<void> {
  syncWatchSubscriptions(registry);
  for (const { watch, fresh } of runWatchCycle(defaultEverySecs, new Date(), { registry })) {
    if (watch.lastError) log(watchFailureLogLine(watch));
    notifyMan(watch, fresh, notify);
  }
  const cap = maxForksPerCycle();
  const keys = [...listWatches().map((watch) => watch.key), ...new WatchJournal().list().map((snapshot) => snapshot.key)];
  const work = await new WatchAutomationRunner(registry).run(keys, Date.now(), cap, log);
  deliverDispatchOwned(log, Math.max(0, cap - work.length), registry);
  const runtime = new WatchRuntime(registry);
  for (const snapshot of runtime.journal.list()) {
    if (snapshot.status !== 'draining' && snapshot.status !== 'closing') continue;
    try { await runtime.close(snapshot.key); }
    catch (error) { log(`watch ${snapshot.key} cleanup: ${error instanceof Error ? error.message : String(error)}`); }
  }
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
