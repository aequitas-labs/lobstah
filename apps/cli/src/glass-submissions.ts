import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANSWER_FILES_MAX,
  DEFAULT_LIMITS,
  DecisionError,
  ThreadError,
  atomicRenameSync,
  displayGrounds,
  isLockBusy,
  loadConfig,
  lobstahHome,
  postThread,
  readDecision,
  readDecisionAnswer,
  readDirIfPresent,
  readRequest,
  readThread,
  resolveGrounds,
  startThread,
  uniqueTempPath,
} from '@lobstah/core';
import type { AnswerSource } from '@lobstah/core';
import { answerKey, viewKey } from './decision-answer.js';

/**
 * The glass's outbox. A card answer, a message to the helm, and a card's
 * first view are each recorded here with one exclusive, synced write, and
 * the glass replies at once. `lobstah glass deliver`, a process of its own,
 * then applies each one: it stores the answer and wakes the helm, or writes
 * the message into its conversation. Lock waits, a full tend scan and the
 * helm's other files never hold up the page or the glass server.
 *
 * Each submission is applied once. Its id is the page's own (a UUID it
 * keeps across retries of the same draft), so a second click or a retried
 * POST finds the first record. A delivery retried after a crash finds what
 * it already wrote: the answer's request id, the conversation's id, and a
 * posted message all carry the submission id.
 */

/** The writes the glass records and delivers later. */
export const SUBMISSION_KINDS = ['decision-answer', 'thread-start', 'thread-post', 'decision-viewed'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/** A recorded submission: what the page sent, as the outbox keeps it until it is delivered. */
export interface GlassSubmission {
  id: string;
  kind: SubmissionKind;
  /** The request's payload, as checked at record time. A new conversation's grounds are already resolved. */
  payload: Record<string, unknown>;
  source: AnswerSource;
  at: string;
}

/** Where a submission stands: waiting for delivery, delivered, or refused for good. */
export type SubmissionState = 'pending' | 'applied' | 'failed';

/** What delivery produced: the stored answer, the conversation written to, or a recorded view. */
export type SubmissionResult = { key: string; request: string } | { thread: string } | { viewed: string };

/** A submission's state, as `GET /api/submissions/<id>` answers it. */
export interface SubmissionStatus {
  id: string;
  kind: SubmissionKind;
  state: SubmissionState;
  at: string;
  settledAt?: string;
  /** A refusal's HTTP-style status and its reason, in words a person reads. */
  status?: number;
  reason?: string;
  result?: SubmissionResult;
}

/** One delivery attempt: settled either way, or `busy` while another process holds a lock it needs. */
export type DeliveryAttempt = { settled: SubmissionStatus } | { busy: string };

/** A page-made submission id: a lowercase UUID, the same shape as a request id and a conversation id. */
export const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** How long a busy submission keeps being retried before it is refused. */
export const DELIVERY_PATIENCE_MS = 2 * 60_000;
/** Settled statuses are kept this long, for a page that asks again after a reload. */
export const SETTLED_KEEP_MS = 86400_000;

export const submissionsDir = (): string => path.join(lobstahHome(), 'glass-submissions');
const bodyFile = (id: string) => path.join(submissionsDir(), `${id}.json`);
const statusFile = (id: string) => path.join(submissionsDir(), `${id}.status.json`);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A `decision-answer` (or message) payload, shape-checked and decoded. */
export interface AnswerPayload {
  key: string;
  option?: string;
  text?: string;
  uploads: Array<{ name: string; data: Buffer }>;
}

/**
 * A `decision-answer` request's payload, shape-checked: the decision key
 * (or a raw question's `<lane>:<id>`), an option, text, and base64 files.
 * Content checks (the key, the option, sizes, types) are answerKey's,
 * shared with `man answer`.
 */
export function decisionAnswerRequest(raw: unknown): AnswerPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DecisionError('payload must be an object');
  const body = raw as { key?: unknown; option?: unknown; text?: unknown; files?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  if (!/^(decision:[a-f0-9]{8}|(work|chore):[A-Za-z0-9-]{1,64})$/.test(key)) throw new DecisionError('Unknown decision.', 404);
  if (body.option !== undefined && typeof body.option !== 'string') throw new DecisionError('option must be a string');
  if (body.text !== undefined && typeof body.text !== 'string') throw new DecisionError('text must be a string');
  if (body.files !== undefined && !Array.isArray(body.files)) throw new DecisionError('files must be a list');
  const files = (body.files ?? []) as unknown[];
  if (files.length > ANSWER_FILES_MAX) throw new DecisionError(`an answer takes at most ${ANSWER_FILES_MAX} files`, 413);
  const uploads = files.map((f) => {
    const file = f as { name?: unknown; data?: unknown };
    if (typeof file !== 'object' || file === null || typeof file.name !== 'string' || typeof file.data !== 'string' || !BASE64.test(file.data)) {
      throw new DecisionError('each file needs a name and base64 data');
    }
    return { name: file.name, data: Buffer.from(file.data, 'base64') };
  });
  return {
    key,
    ...(body.option !== undefined ? { option: body.option as string } : {}),
    ...(body.text !== undefined ? { text: body.text as string } : {}),
    uploads,
  };
}

/** limits.attachmentMaxBytes; a config error falls back to the default. */
export function attachmentLimit(): number {
  try {
    return loadConfig().limits.attachmentMaxBytes;
  } catch {
    return DEFAULT_LIMITS.attachmentMaxBytes;
  }
}

/** A refusal at record time, with the status the glass answers. */
export class SubmissionRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const refusal = (error: unknown, fallback: string): SubmissionRefused =>
  error instanceof SubmissionRefused
    ? error
    : error instanceof DecisionError || error instanceof ThreadError
      ? new SubmissionRefused(error.message, error.status)
      : new SubmissionRefused(fallback, 400);

/**
 * The checks a submission passes before it is recorded: its shape, and what
 * a few small reads can tell (the card stands and is unanswered, the
 * conversation exists and is open). Delivery checks everything again.
 * Returns the payload to record.
 */
export function checkSubmission(kind: SubmissionKind, raw: unknown): Record<string, unknown> {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SubmissionRefused('Enter a message', 400);
    const payload = { ...(raw as Record<string, unknown>) };
    delete payload.submission;
    if (kind === 'decision-viewed') {
      if (typeof payload.key !== 'string' || payload.key.length > 120) throw new SubmissionRefused('A decision key is required.', 400);
      return { key: payload.key };
    }
    if (kind === 'decision-answer') {
      const answer = decisionAnswerRequest(payload);
      if (answer.key.startsWith('decision:')) {
        const card = readDecision(answer.key);
        if (!card) throw new SubmissionRefused('This decision was withdrawn.', 404);
        if (readDecisionAnswer(answer.key)) throw new SubmissionRefused('This decision has already been answered.', 409);
        if (card.permission && !answer.option) throw new SubmissionRefused('Choose an answer.', 400);
      }
      if (answer.option === undefined && !answer.text?.trim() && answer.uploads.length === 0) throw new SubmissionRefused('Choose an option, write an answer, or attach a file.', 400);
      return payload;
    }
    const message = decisionAnswerRequest({ ...payload, key: 'decision:00000000' });
    if (!message.text?.trim() && message.uploads.length === 0) throw new SubmissionRefused('Write a message or attach a file', 400);
    if (kind === 'thread-post') {
      if (typeof payload.id !== 'string') throw new SubmissionRefused('Choose a conversation', 400);
      const thread = readThread(payload.id);
      if (!thread) throw new SubmissionRefused('Conversation not found', 404);
      if (thread.state === 'resolved') throw new SubmissionRefused('Reopen this conversation before adding to it', 409);
      return payload;
    }
    if (payload.grounds !== undefined && typeof payload.grounds !== 'string') throw new SubmissionRefused('Choose a grounds', 400);
    if (payload.about !== undefined && (typeof payload.about !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.about))) throw new SubmissionRefused('Choose a dispatch', 400);
    const config = loadConfig();
    return { ...payload, grounds: displayGrounds(resolveGrounds(config, payload.grounds as string | undefined).name, config) };
  } catch (error) {
    throw refusal(error, kind === 'decision-answer' ? 'The answer could not be stored.' : 'The message could not be saved');
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write `text` to a new temporary file beside `file`, synced to disk. Returns the temporary file. */
function writeSynced(file: string, text: string): string {
  const tmp = uniqueTempPath(file);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/**
 * Record a submission: one synced write, published with a hard link so a
 * second record of the same id never replaces the first. The write is
 * asynchronous, so the glass keeps answering other requests while the disk
 * syncs. Resolves to the submission's status and whether this call recorded it.
 */
export async function recordSubmission(submission: GlassSubmission): Promise<{ status: SubmissionStatus; recorded: boolean }> {
  if (!SUBMISSION_ID.test(submission.id)) throw new SubmissionRefused('Reload the page and try again.', 400);
  const known = readSubmissionStatus(submission.id);
  if (known) return { status: known, recorded: false };
  await fs.promises.mkdir(submissionsDir(), { recursive: true });
  const file = bodyFile(submission.id);
  const tmp = uniqueTempPath(file);
  const handle = await fs.promises.open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(submission));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let recorded = true;
  try {
    await fs.promises.link(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    recorded = false;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
  return { status: readSubmissionStatus(submission.id) ?? pendingStatus(submission), recorded };
}

const pendingStatus = (s: GlassSubmission): SubmissionStatus => ({ id: s.id, kind: s.kind, state: 'pending', at: s.at });

/** A submission's state: its settled status, pending while only its record exists, or undefined when the outbox never had it. */
export function readSubmissionStatus(id: string): SubmissionStatus | undefined {
  if (!SUBMISSION_ID.test(id)) return undefined;
  const settled = readJson<SubmissionStatus>(statusFile(id));
  if (settled) return settled;
  const body = readJson<GlassSubmission>(bodyFile(id));
  return body ? pendingStatus(body) : undefined;
}

/** Submissions recorded and not yet settled, oldest first. */
export function pendingSubmissions(): GlassSubmission[] {
  return readDirIfPresent(submissionsDir())
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .flatMap((name) => {
      const id = name.slice(0, -'.json'.length);
      if (fs.existsSync(statusFile(id))) {
        // Settled before its record was removed: finish the removal.
        fs.rmSync(bodyFile(id), { force: true });
        return [];
      }
      const body = readJson<GlassSubmission>(bodyFile(id));
      return body && body.id === id ? [body] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Settle a submission: its status first, then its record (which may hold an answer's files) is removed. */
function settle(submission: GlassSubmission, outcome: Omit<SubmissionStatus, 'id' | 'kind' | 'at' | 'settledAt'>, now: Date): SubmissionStatus {
  const status: SubmissionStatus = { id: submission.id, kind: submission.kind, at: submission.at, settledAt: now.toISOString(), ...outcome };
  const file = statusFile(submission.id);
  atomicRenameSync(writeSynced(file, JSON.stringify(status)), file);
  fs.rmSync(bodyFile(submission.id), { force: true });
  return status;
}

/** What this submission already wrote, when an earlier delivery stopped before settling it. */
function alreadyDelivered(submission: GlassSubmission): SubmissionResult | undefined {
  const { id, kind, payload } = submission;
  if (kind === 'decision-answer') {
    const request = readRequest(id);
    if (request?.kind === 'decision-answer') return { key: String(request.payload.key), request: id };
    const key = String(payload.key);
    if (key.startsWith('decision:') && readDecisionAnswer(key)?.request === id) return { key, request: id };
  }
  if (kind === 'thread-start' && readThread(id)) return { thread: id };
  return undefined;
}

/** Apply one submission. Throws what the core write throws. */
function apply(submission: GlassSubmission): SubmissionResult {
  const { id, kind, payload, source } = submission;
  if (kind === 'decision-viewed') return { viewed: viewKey(String(payload.key)).key };
  if (kind === 'decision-answer') {
    const { key, ...answer } = decisionAnswerRequest(payload);
    const { decision, answer: stored } = answerKey(key, { ...answer, by: source, request: id });
    return { key: decision.key, request: stored.request };
  }
  const message = decisionAnswerRequest({ ...payload, key: 'decision:00000000' });
  if (kind === 'thread-post') {
    const thread = postThread(String(payload.id), { text: message.text, uploads: message.uploads, maxBytes: attachmentLimit(), submission: id });
    return { thread: thread.id };
  }
  const thread = startThread({
    id,
    grounds: String(payload.grounds),
    text: message.text,
    uploads: message.uploads,
    maxBytes: attachmentLimit(),
    about: payload.about as string | undefined,
  });
  return { thread: thread.id };
}

/**
 * One delivery attempt. A lock another process holds is `busy` until the
 * submission has waited DELIVERY_PATIENCE_MS; then, like any other refusal,
 * it settles as failed with a reason the page shows beside Retry.
 */
export function deliverSubmission(submission: GlassSubmission, now = new Date()): DeliveryAttempt {
  const done = alreadyDelivered(submission);
  if (done) return { settled: settle(submission, { state: 'applied', result: done }, now) };
  try {
    return { settled: settle(submission, { state: 'applied', result: apply(submission) }, now) };
  } catch (error) {
    if (isLockBusy(error) && now.getTime() - Date.parse(submission.at) < DELIVERY_PATIENCE_MS) {
      return { busy: error instanceof Error ? error.message : String(error) };
    }
    // An earlier delivery may have stored it and stopped before settling: a 409 then means it is done.
    const late = alreadyDelivered(submission);
    if (late) return { settled: settle(submission, { state: 'applied', result: late }, now) };
    const known = error instanceof DecisionError || error instanceof ThreadError;
    const reason = isLockBusy(error)
      ? 'The helm’s files stayed busy. Try again.'
      : known
        ? (error as Error).message
        : submission.kind === 'decision-answer'
          ? 'The answer could not be stored.'
          : submission.kind === 'decision-viewed'
            ? 'The view could not be recorded.'
            : 'The message could not be saved';
    return { settled: settle(submission, { state: 'failed', status: known ? (error as DecisionError | ThreadError).status : 500, reason }, now) };
  }
}

/** Remove settled statuses older than SETTLED_KEEP_MS. */
export function pruneSettledSubmissions(now = Date.now()): void {
  for (const name of readDirIfPresent(submissionsDir())) {
    if (!name.endsWith('.status.json')) continue;
    const status = readJson<SubmissionStatus>(path.join(submissionsDir(), name));
    if (!status?.settledAt || now - Date.parse(status.settledAt) > SETTLED_KEEP_MS) fs.rmSync(path.join(submissionsDir(), name), { force: true });
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `lobstah glass deliver`: deliver every pending submission, oldest first.
 * Busy ones wait and are tried again, with a growing pause; submissions for
 * the same card or conversation keep their order. Each settled id is
 * reported through `onSettled` (the glass reads it from this process's
 * output). Returns once the outbox holds nothing pending.
 */
export async function deliverPending(onSettled: (status: SubmissionStatus) => void, opts: { pauseMs?: (attempt: number) => number } = {}): Promise<void> {
  const wait = opts.pauseMs ?? ((attempt: number) => Math.min(2000, 100 * 2 ** attempt));
  for (let attempt = 0; ; attempt++) {
    const pending = pendingSubmissions();
    if (pending.length === 0) return;
    const blocked = new Set<string>();
    let progressed = false;
    for (const submission of pending) {
      const target = deliveryTarget(submission);
      if (blocked.has(target)) continue;
      const result = deliverSubmission(submission);
      if ('busy' in result) {
        blocked.add(target);
        continue;
      }
      progressed = true;
      onSettled(result.settled);
    }
    if (progressed) attempt = -1;
    else await pause(wait(attempt));
  }
}

/** What a submission writes to: later submissions for the same target wait for it. */
function deliveryTarget(submission: GlassSubmission): string {
  if (submission.kind === 'thread-post') return `thread:${String(submission.payload.id)}`;
  if (submission.kind === 'thread-start') return `thread:${submission.id}`;
  return `card:${String(submission.payload.key)}`;
}
