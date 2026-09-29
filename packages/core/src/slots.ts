import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs } from './paths.js';
import { activeIds } from './queue.js';
import { readSessionClaim } from './soak.js';
import { readStatusLog, waitingView } from './status.js';
import type { WaitingView } from './status.js';
import { TERMINAL_VERBS } from './types.js';
import type { Lane, RunnerInfo } from './types.js';

/** A trap is an interactive session, not a daemon-spawned runner. */
export function isTrapCatch(id: string, lane: Lane): boolean {
  return readSessionClaim(id, lane)?.by.startsWith('wt:') ?? false;
}

/**
 * The worker's last report is `done` or `failed`. A finished dispatch can
 * still sit in `active/` while its runner exits; it holds no slot.
 */
export function isFinished(id: string, lane: Lane): boolean {
  const verb = readStatusLog(id, lane).at(-1)?.verb;
  return verb !== undefined && TERMINAL_VERBS.includes(verb);
}

/**
 * The worker's last report is `paused`: the dispatch is parked. A parked
 * headless dispatch has no harness running and holds no slot; an operator
 * message, the end of its `--until`, or the end of its PR wakes it.
 */
export function isParked(id: string, lane: Lane): boolean {
  const last = readStatusLog(id, lane).at(-1);
  if (last?.verb !== 'paused') return false;
  // A runner started after the pause is a wake: it holds a slot from its spawn.
  return !(runnerStartedAt(id, lane) > last.at);
}

function runnerStartedAt(id: string, lane: Lane): string {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')) as Partial<RunnerInfo>;
    return typeof info.startedAt === 'string' ? info.startedAt : '';
  } catch {
    return '';
  }
}

export interface SlotUsage {
  /** Headless dispatches that hold a slot. */
  headless: number;
  traps: number;
  /** Headless dispatches parked on `paused`: shown, but they hold no slot. */
  parked: number;
}

/** Active dispatches that hold a slot. A finished or parked dispatch is not counted. */
export function slotUsage(lane: Lane): SlotUsage {
  let ids: string[];
  try { ids = activeIds(lane); } catch { return { headless: 0, traps: 0, parked: 0 }; }
  ids = ids.filter((id) => !isFinished(id, lane));
  const traps = ids.filter((id) => isTrapCatch(id, lane)).length;
  const parked = ids.filter((id) => !isTrapCatch(id, lane) && isParked(id, lane)).length;
  return { headless: ids.length - traps - parked, traps, parked };
}

/** One parked dispatch, for status views: what it waits on and for how long. */
export interface ParkedDispatch {
  id: string;
  lane: Lane;
  /** A trap's catch (the trap's session holds it) rather than a headless dispatch. */
  trap: boolean;
  /** When it paused (the report's time). */
  since: string;
  /** Seconds parked so far. */
  parkedSecs: number;
  note?: string;
  /** What it waits on, when the report said (`--waiting-on`, `--link`, `--until`). */
  waiting?: WaitingView;
}

/** Every active dispatch parked on `paused`, oldest first. */
export function parkedDispatches(now = Date.now()): ParkedDispatch[] {
  const out: ParkedDispatch[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    let ids: string[];
    try { ids = activeIds(lane); } catch { continue; }
    for (const id of ids) {
      const last = readStatusLog(id, lane).at(-1);
      if (last?.verb !== 'paused' || (!isTrapCatch(id, lane) && !isParked(id, lane))) continue;
      const waiting = waitingView(last, now);
      out.push({
        id,
        lane,
        trap: isTrapCatch(id, lane),
        since: last.at,
        parkedSecs: Math.max(0, Math.round((now - (Date.parse(last.at) || now)) / 1000)),
        ...(last.note ? { note: last.note } : {}),
        ...(waiting ? { waiting } : {}),
      });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}
