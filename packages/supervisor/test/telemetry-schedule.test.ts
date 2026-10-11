import { afterEach, expect, it, vi } from 'vitest';
import { startTelemetrySchedule, TELEMETRY_CHECK_MS } from '../src/telemetry-schedule.js';
afterEach(() => vi.useRealTimers());
it('has its own clock: no initial send or wharf callback, and stops cleanly', async () => {
  vi.useFakeTimers(); const send = vi.fn(async () => {});
  const stop = startTelemetrySchedule(send, 1234);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1233); expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(TELEMETRY_CHECK_MS); expect(send).toHaveBeenCalledTimes(2);
  stop(); await vi.advanceTimersByTimeAsync(TELEMETRY_CHECK_MS); expect(send).toHaveBeenCalledTimes(2);
});
