import { postNotice } from '@lobstah/core';
import type { PickupState } from './state.js';
import type { MergeSource } from './types.js';

/** Four backoffs put the fifth attempt ten minutes after the first. Polls may run later. */
const RETRY_DELAYS_MS: readonly number[] = [40_000, 80_000, 160_000, 320_000];

/** Gate a whole stack operation so every retry re-enters its fresh PR and stack checks. */
export function stackAttemptReady(state: PickupState, key: string, log: (message: string) => void): boolean {
  const retry = state.stackRetry(key);
  if (retry?.stopped || (retry && Date.now() < retry.retryAt)) return false;
  log(`${key}: stack attempt ${(retry?.failures ?? 0) + 1}/5`);
  return true;
}

/** Only non-conflict client errors are terminal before the retry budget is spent. */
export function stackAttemptFailed(
  source: MergeSource,
  state: PickupState,
  key: string,
  error: unknown,
  log: (message: string) => void,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status) : Number(/(?:HTTP |: )(\d{3})\b/.exec(message)?.[1]);
  const failures = (state.stackRetry(key)?.failures ?? 0) + 1;
  const terminal = status >= 400 && status < 500 && status !== 409 && status !== 422;
  const delay = RETRY_DELAYS_MS[failures - 1];
  const stopped = terminal || delay === undefined;
  state.setStackRetry(key, { failures, retryAt: Date.now() + (delay ?? 0), stopped });
  log(`${key}: stack attempt ${failures}/5 failed: ${message}${stopped ? '; stopped' : `; refresh and retry in ${delay! / 1000}s`}`);
  if (stopped) postNotice({ kind: 'stack-stopped', repo: source.repoKey(),
    text: `Stack merge stopped after ${failures} attempt(s). Check the pickup log before retrying.` });
}

/** Main's bounded retry policy classifies transport failures and explicit HTTP responses. */
export function hasStackRetryPolicy(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status) : Number(/(?:HTTP |: )(\d{3})\b/.exec(message)?.[1]);
  return status >= 400 && status < 600;
}
