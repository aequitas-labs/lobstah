import {
  acknowledge,
  appendEvent,
  appendStatus,
  cancelRequested,
  mergeEvidence,
  readStatusLog,
  TERMINAL_VERBS,
  touchEvents,
  unhandled,
} from '@lobstah/core';
import type { Lane, Verb } from '@lobstah/core';
import type { AdapterRun } from '@lobstah/adapters';

/**
 * Verbs a worker reports when it stops to wait on a human. A turn that ends
 * on one of these keeps the run open until the inbox answers, a cancel, or
 * the wall clock — the contract tells the worker it will be resumed.
 */
export const WAITING_VERBS: readonly Verb[] = ['needs-decision', 'blocked', 'paused'];

export interface DriveOpts {
  id: string;
  lane: Lane;
  /** Inbox/cancel poll cadence while waiting; each poll also heartbeats. */
  pollMs?: number;
  /** True once the run is being torn down externally (wall clock). */
  stopped?: () => boolean;
}

export interface DriveResult {
  cancelled: boolean;
  /** Tool calls and assistant text seen — zero means the session never did
   * any work (a resume the harness refused ends this way). */
  activity: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hand every queued inbox message to the next turn. Returns how many. */
function deliver(run: AdapterRun, id: string, lane: Lane): number {
  const msgs = unhandled(id, lane);
  for (const m of msgs) {
    run.send(m.text);
    acknowledge(id, lane, m.file);
  }
  return msgs.length;
}

/**
 * Pump the adapter's events into the dispatch's stream and decide, at every
 * turn end, whether the run continues: queued operator messages go into the
 * next turn; a worker waiting on a question is held open until answered;
 * otherwise input ends and the harness finishes.
 */
export async function drive(run: AdapterRun, opts: DriveOpts): Promise<DriveResult> {
  const { id, lane, pollMs = 3000, stopped = () => false } = opts;
  let cancelled = false;
  let activity = 0;
  // A harness that exits on its own (crash, external kill) ends any wait.
  let finished = false;
  void run.done.then(() => (finished = true));

  const cancel = () => {
    cancelled = true;
    run.kill();
  };

  // The answer supersedes the standing question: it ends reminders, and a
  // next turn that ends without a report falls to the done path below
  // instead of waiting again on a question already answered.
  const answered = (verb: Verb) => {
    appendStatus(id, lane, 'working', 'operator message delivered');
    appendEvent(id, lane, { at: new Date().toISOString(), type: 'runner', data: { resumed: verb } });
  };

  /** Wait for an inbox message. Heartbeats the event stream every poll. */
  const awaitAnswer = async (verb: Verb): Promise<void> => {
    appendEvent(id, lane, { at: new Date().toISOString(), type: 'runner', data: { waiting: verb } });
    while (true) {
      if (stopped() || finished) return;
      if (cancelRequested(id, lane)) return cancel();
      if (deliver(run, id, lane) > 0) return answered(verb);
      touchEvents(id, lane);
      await sleep(pollMs);
    }
  };

  for await (const ev of run.events) {
    appendEvent(id, lane, ev);
    if (ev.type === 'tool-start' || ev.type === 'text') activity++;
    if (ev.type === 'session' && ev.data?.sessionId) {
      mergeEvidence(id, lane, { sessionId: String(ev.data.sessionId) });
    }
    if (ev.type !== 'turn-end' || cancelled || stopped()) continue;
    if (cancelRequested(id, lane)) {
      cancel();
      continue;
    }
    const lastVerb = readStatusLog(id, lane).at(-1)?.verb;
    const waiting = lastVerb !== undefined && WAITING_VERBS.includes(lastVerb);
    if (deliver(run, id, lane) > 0) {
      if (waiting) answered(lastVerb);
      continue;
    }
    if (waiting) {
      await awaitAnswer(lastVerb);
      continue;
    }
    // `done`/`failed`: the worker is finished. `working` (or no report) with
    // an empty inbox is the "brief fulfilled but forgot to report" case — end
    // the session and let settle() stamp done.
    run.end();
  }
  return { cancelled, activity };
}

export interface SettleInput {
  cancelled: boolean;
  wallClockHit: boolean;
  error?: string;
}

/** Stamp the final verb for a run that has fully stopped. */
export function settle(id: string, lane: Lane, r: SettleInput): void {
  const lastVerb = readStatusLog(id, lane).at(-1)?.verb;
  if (r.cancelled) appendStatus(id, lane, 'failed', 'cancelled by operator');
  else if (r.wallClockHit) appendStatus(id, lane, 'failed', 'wall-clock limit exceeded');
  else if (r.error) appendStatus(id, lane, 'failed', r.error.slice(0, 500));
  else if (!lastVerb || !TERMINAL_VERBS.includes(lastVerb)) appendStatus(id, lane, 'done');
}
