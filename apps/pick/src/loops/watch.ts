import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appendWatchEvents,
  enqueue,
  laneDirs,
  lastEventAt,
  listWatches,
  markFollowUp,
  pendingWatchEvents,
  readWatch,
  readWatchEvents,
  readStatusLog,
  reconcile,
  removeWatch,
  runWatchCheck,
  setWatchCursor,
  watchDue,
} from '@lobstah/core';
import { readSessionClaim, readSoak } from '@lobstah/core';
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
function spawnContinuation(w: Watch, pending: WatchEvent[], log: (m: string) => void): void {
  const owner = w.owner.slice('dispatch:'.length);
  const target = w.lastFollowUpId && !laneOf(w.lastFollowUpId) ? owner : (w.lastFollowUpId ?? owner);
  const targetLane = laneOf(target);
  if (!targetLane) {
    log(`watch ${w.key}: owner dispatch ${target} is gone — dropping watch`);
    removeWatch(w.key);
    return;
  }
  const descriptor = descriptorOf(target, targetLane);
  if (!descriptor) {
    log(`watch ${w.key}: no descriptor for ${target} — dropping watch`);
    removeWatch(w.key);
    return;
  }
  const id = randomUUID();
  const brief = (w.brief ?? DEFAULT_BRIEF)
    .replaceAll('{key}', w.key)
    .replaceAll('{events}', JSON.stringify(pending, null, 2));
  // A chain worked by a live soaking session gets its continuation addressed
  // there — the session picks it up at its next park instead of a headless
  // fork running beside it. If the trap ghosts, the sweep strips the
  // registration and the daemon claims the bait as unaddressed.
  const claim = readSessionClaim(target, targetLane);
  const claimant = claim?.by.startsWith('session:') ? claim.by.slice('session:'.length) : undefined;
  const live = claimant !== undefined && readSoak(claimant) !== undefined;
  enqueue(
    { id, repo: descriptor.repo, brief, followUp: target, ...(live ? { for: claim!.by } : {}) },
    'work',
  );
  markFollowUp(w.key, id, readWatchEvents(w.key).length);
  log(
    `watch ${w.key}: ${pending.length} event(s) → continuation ${id} ` +
      (live ? `(addressed to soaking ${claimant!.slice(0, 8)})` : `(forks ${target})`),
  );
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

/** Fork continuations for buffered dispatch-owned events, retire spent watches. */
function deliverDispatchOwned(log: (m: string) => void): void {
  for (const { watch, events } of pendingWatchEvents(false, 'dispatch')) {
    if (watch.lastFollowUpId && !isTerminal(watch.lastFollowUpId)) continue; // one continuation in flight
    spawnContinuation(watch, events, log);
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
      if (watch.lastError) log(`watch ${w.key}: check failed — ${watch.lastError}`);
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
