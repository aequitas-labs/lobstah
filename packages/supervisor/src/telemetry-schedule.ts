import { randomInt } from 'node:crypto';
import { sendTelemetry } from '@lobstah/core';

export const TELEMETRY_CHECK_MS = 10 * 60_000;
/** Own clock, not a tick, hook, wharf call, wake event or sign-in callback.
 * Sending itself permits only one attempt per UTC date. */
export function startTelemetrySchedule(send: () => Promise<unknown> = sendTelemetry, firstDelay = randomInt(1, TELEMETRY_CHECK_MS)): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    if (stopped) return;
    void send().catch(() => {});
    timer = setTimeout(run, TELEMETRY_CHECK_MS); timer.unref();
  };
  timer = setTimeout(run, firstDelay); timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
