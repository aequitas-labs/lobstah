import {
  acknowledge,
  ActivityTracker,
  appendEvent,
  appendStatus,
  cancelRequested,
  mergeEvidence,
  readStatusLog,
  TERMINAL_VERBS,
  touchEvents,
  unhandled,
  writeActivity,
} from '@lobstah/core';
import type { Lane, NormalizedEvent, Verb } from '@lobstah/core';
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
  /**
   * How long a turn that ends without a report is held open while background
   * work is live (`[limits].backgroundWaitSecs`, default 30 minutes).
   */
  backgroundWaitMs?: number;
  /** Once background work settles, how long to wait for the harness to wake the worker. */
  settleGraceMs?: number;
  /** The worktree: activity shows file targets relative to it. */
  cwd?: string;
  /** Minimum interval between activity writes of the same kind (default 10s). */
  activityThrottleMs?: number;
}

/**
 * What a worker hears when a turn ends without a report. Only the worker's own
 * report finishes a dispatch: a quiet turn has meant a question never asked, a
 * push still running when the session was ended, and a conclusion no one saw.
 */
export function unreportedNudge(id: string): string {
  return (
    `Your turn ended without a status report, so this dispatch is not finished. ` +
    `If the work is complete, run \`lobstah report ${id} done "<what you did>"\`, adding \`--pr <url>\` if you opened a PR. ` +
    `If no change was needed, report \`done\` with a note saying why. ` +
    `If a human has to answer a question, or you are blocked, report \`needs-decision\` or \`blocked\` with it. ` +
    `If you are waiting on something, run it in the background: you are woken when it finishes.`
  );
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
 * next turn; a worker waiting on a question is held open until answered; a
 * worker that reported done or failed is finished. A turn that ends with no
 * report is not finished: it is held open while its background work runs, then
 * the worker is asked once to report, and silence after that fails the run.
 */
export async function drive(run: AdapterRun, opts: DriveOpts): Promise<DriveResult> {
  const {
    id,
    lane,
    pollMs = 3000,
    stopped = () => false,
    backgroundWaitMs = 30 * 60_000,
    settleGraceMs = 120_000,
  } = opts;
  // Activity comes from the stream, never from the model: every event the
  // runner sees can update what the dispatch is doing now.
  const tracker = new ActivityTracker((a) => writeActivity(id, lane, a), {
    root: opts.cwd,
    throttleMs: opts.activityThrottleMs,
  });
  const record = (ev: NormalizedEvent) => {
    appendEvent(id, lane, ev);
    tracker.observe(ev);
  };
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
    record({ at: new Date().toISOString(), type: 'runner', data: { waiting: verb } });
    while (true) {
      if (stopped() || finished) return;
      if (cancelRequested(id, lane)) return cancel();
      if (deliver(run, id, lane) > 0) return answered(verb);
      touchEvents(id, lane);
      await sleep(pollMs);
    }
  };

  let liveBackground = 0;
  let nudged = false;
  let hold: { heartbeat: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> } | undefined;
  const runnerEvent = (data: Record<string, unknown>) =>
    record({ at: new Date().toISOString(), type: 'runner', data });

  const releaseHold = () => {
    if (!hold) return;
    clearInterval(hold.heartbeat);
    clearTimeout(hold.expiry);
    hold = undefined;
  };

  /** A turn ended with no report and nothing to wait on: ask once, then fail. */
  const unreported = () => {
    if (!nudged) {
      nudged = true;
      runnerEvent({ nudged: 'unreported' });
      run.send(unreportedNudge(id));
      return;
    }
    appendStatus(id, lane, 'failed', 'ended without reporting a result, after being asked to');
    run.end();
  };

  /**
   * Hold a quiet turn open while background work runs: the harness wakes the
   * worker when it settles. Heartbeats keep the wedge detector off it; the
   * window bounds work that never settles, such as a dev server.
   */
  const holdOpen = (ms: number) => {
    releaseHold();
    const heartbeat = setInterval(() => {
      if (cancelRequested(id, lane)) {
        releaseHold();
        cancel();
        return;
      }
      touchEvents(id, lane);
    }, pollMs);
    const expiry = setTimeout(() => {
      releaseHold();
      runnerEvent({ backgroundWait: 'expired', live: liveBackground });
      unreported();
    }, ms);
    hold = { heartbeat, expiry };
  };

  for await (const ev of run.events) {
    record(ev);
    if (ev.type === 'background') {
      liveBackground = Number(ev.data?.live ?? 0);
      // The work settled: the harness should wake the worker now, so stop
      // waiting out the whole window for it.
      if (hold && liveBackground === 0) holdOpen(settleGraceMs);
      continue;
    }
    releaseHold(); // any other event means the worker is awake
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
    // `done`/`failed`: the worker said it is finished.
    if (lastVerb !== undefined && TERMINAL_VERBS.includes(lastVerb)) {
      run.end();
      continue;
    }
    // A turn the harness ended in error (a refused resume, the turn limit)
    // cannot take another turn, so asking it to report is pointless: end it
    // and let the runner's error handling and settle() say why.
    const subtype = ev.data?.subtype;
    if (subtype !== undefined && subtype !== 'success') {
      run.end();
      continue;
    }
    // No report. The worker may be waiting on background work it started —
    // a push behind a slow pre-push gate — and the harness wakes it when that
    // settles; ending the session here would kill the work.
    if (liveBackground > 0) {
      runnerEvent({ holding: 'background', live: liveBackground, forSecs: Math.round(backgroundWaitMs / 1000) });
      holdOpen(backgroundWaitMs);
      continue;
    }
    unreported();
  }
  releaseHold();
  tracker.flush();
  tracker.stop();
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
  // Only the worker's own report is `done`. A run that stopped without one —
  // a harness that exited on its own, a turn limit — did not say it finished.
  else if (!lastVerb || !TERMINAL_VERBS.includes(lastVerb)) appendStatus(id, lane, 'failed', 'stopped without reporting a result');
}
