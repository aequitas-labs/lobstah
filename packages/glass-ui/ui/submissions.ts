import { backend } from './backend.js';
import type { SubmissionVerdict } from './backend.js';

/**
 * Answers and messages as submissions. The page names each one with an id
 * of its own and keeps that id while the same draft is retried, so a double
 * click or a resend after a dropped connection is recorded once. The server
 * replies as soon as the submission is on disk and delivers it after; the
 * page shows it as sent at once and follows it here until it settles.
 */

/** What became of a submission. `retrySame`: whether it may have been recorded, so a retry must reuse its id. */
export type SubmissionOutcome = { state: 'applied' } | { state: 'failed'; reason: string; retrySame: boolean };

/** Whether this page's source takes submissions. Without one, a write waits for the server as before. */
export const takesSubmissions = (): boolean => !!backend().submission;

/** A new submission id: a random v4 UUID, made without `crypto.randomUUID` so it works outside a secure context too. */
export function newSubmissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A short fingerprint of what a submission carries: a retry reuses its id only while the draft is unchanged. */
export function submissionFingerprint(payload: unknown): string {
  const text = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** How long one status read waits on the server for the submission to settle. */
const FOLLOW_WAIT_MS = 10_000;
/** Status reads that may fail in a row before the page stops following and offers a retry. */
const FOLLOW_MISSES = 3;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send one submission and follow it until it settles. Resolves `applied`
 * once the helm's files hold it, or `failed` with the reason to show.
 */
export async function submit(
  kind: string,
  id: string,
  payload: Record<string, unknown>,
  token: string,
  unsent: string,
): Promise<SubmissionOutcome> {
  let verdict: SubmissionVerdict;
  try {
    const response = await backend().request<SubmissionVerdict>(kind, { ...payload, submission: id }, token);
    verdict = response.body;
    if (!response.ok || verdict.ok === false)
      return { state: 'failed', reason: verdict.reason ?? unsent, retrySame: verdict.state !== 'failed' };
  } catch {
    return { state: 'failed', reason: unsent, retrySame: true };
  }
  if (verdict.state !== 'pending') return { state: 'applied' };
  return follow(id, token, unsent);
}

/** Read a recorded submission's state until it settles. */
async function follow(id: string, token: string, unsent: string): Promise<SubmissionOutcome> {
  const read = backend().submission;
  if (!read) return { state: 'applied' };
  for (let misses = 0; misses < FOLLOW_MISSES;) {
    try {
      const { body } = await read(id, token, FOLLOW_WAIT_MS);
      if (body.state === 'applied') return { state: 'applied' };
      if (body.state === 'failed') return { state: 'failed', reason: body.reason ?? unsent, retrySame: false };
      if (body.state !== 'pending') {
        misses++;
        await pause(1000);
      }
    } catch {
      misses++;
      await pause(1000);
    }
  }
  return { state: 'failed', reason: unsent, retrySame: true };
}
