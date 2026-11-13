import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { liveHeavyTickets, recentHeavyRuns } from './heavy.js';
import type { HeavyRun } from './heavy.js';
import { sendMessageOnce } from './inbox.js';
import { activeIds } from './queue.js';
import { readStatusLog } from './status.js';
import type { Lane } from './types.js';

/** One receipt per run, shared by the holder and the daemon across retries. */
export function heavyResultDeliveryId(run: Pick<HeavyRun, 'seq' | 'joinedAt' | 'dispatch'>, pauseAt?: string): string {
  const runId =
    run.seq !== undefined
      ? String(run.seq)
      : createHash('sha256')
          .update(`${run.dispatch ?? ''}:${run.joinedAt}`)
          .digest('hex')
          .slice(0, 24);
  const pauseId = pauseAt ? `-${createHash('sha256').update(pauseAt).digest('hex').slice(0, 16)}` : '';
  return `heavy-run-${runId}${pauseId}`;
}

/** The completion a paused trap reads, with a bounded tail from its retained output. */
export function heavyResultText(run: Pick<HeavyRun, 'command' | 'exit' | 'log'>): string {
  const result = run.exit === undefined ? 'ended (exit code unavailable)' : `exited ${run.exit}`;
  let tail = '';
  if (run.log) {
    try {
      const fd = fs.openSync(run.log, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const bytes = Buffer.alloc(Math.min(size, 16 * 1024));
        fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
        tail = bytes.toString('utf8').trimEnd().split('\n').slice(-15).join('\n');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* A removed log still leaves its path and exit status. */
    }
  }
  return [`heavy: ${run.command} ${result}`, `log: ${run.log ?? 'not captured by this version'}`, ...(tail ? ['', tail] : [])].join('\n');
}

/** Resolve a heavy pause as soon as a run ends, or immediately when no live job exists. */
export function wakeHeavyWait(id: string, lane: Lane, now = Date.now()): void {
  const pause = readStatusLog(id, lane).at(-1);
  if (pause?.verb !== 'paused' || pause.waitingOn !== 'heavy') return;
  const pausedAt = Date.parse(pause.at);
  const runs = recentHeavyRuns()
    .filter((run) => run.dispatch === id && (!run.lane || run.lane === lane) && Date.parse(run.endedAt) <= now)
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  let completed = runs.filter((run) => Date.parse(run.endedAt) >= pausedAt);
  const live = liveHeavyTickets({ dispatch: id }, now);
  // A fast command may finish just before its caller records the pause.
  if (!completed.length && !live.length) {
    const latest = runs.at(-1);
    if (latest && pausedAt - Date.parse(latest.endedAt) <= 5_000) completed = [latest];
  }
  for (const run of completed) sendMessageOnce(id, lane, heavyResultDeliveryId(run, pause.at), heavyResultText(run), 'heavy');
  if (completed.length || live.length) return;
  const receipt = createHash('sha256').update(`${id}:${lane}:${pause.at}`).digest('hex').slice(0, 24);
  sendMessageOnce(
    id,
    lane,
    `heavy-missing-${receipt}`,
    'heavy: no heavy job found\nResume the dispatch or start the intended heavy command.',
    'heavy',
  );
}

/** Repair a missed holder delivery on the daemon's ordinary pass. */
export function wakeHeavyWaits(now = Date.now()): void {
  for (const lane of ['work', 'chore'] as const) for (const id of activeIds(lane)) wakeHeavyWait(id, lane, now);
}
