import type {
  Attachment,
  GlassDecision,
  GlassDispatch,
  GlassDispatchSummary,
  GlassReport,
  GlassReview,
  GlassSnapshot,
  GlassTrap,
  LandedCatch,
  StatusEntry,
  TendAttention,
} from '@lobstah/core';
import { LANDED_WINDOW_MS } from '../src/glass-diff.js';
import { attachCommand } from './wharf-model.js';
import type { DispatchView, WharfDetail, WharfDocument, WharfFile, WharfGlass, Worker } from './wharf-model.js';

/**
 * The wharf's account, as the shared glass reads it: one GlassSnapshot, the
 * type the local glass renders. Everything here is a projection of what the
 * wharf records. A field the wharf does not record stays absent (no PRs,
 * stacks, notices, TODOs, grants or stats), and the wharf backend's
 * capabilities hide the tabs that would read them; nothing is faked as empty
 * or zero.
 *
 * Keys follow the local glass's: a job's attention key is `work:<id>`, and a
 * wharf document's is `decision:<id>` or `report:<id>`. Every write maps the
 * key back to the wharf id (wharfId).
 */

/** The wharf has one lane; its jobs show in the local glass's work lane. */
const LANE = 'work';

/** The attention kinds the deck shows for a wharf: decisions, raw questions, landings, reports. */
export const WHARF_ATTENTION_KINDS = ['decision', 'question', 'landed', 'report'];

/** A file the wharf holds, as the glass names an attachment: `url` is where the browser fetches it. */
export interface WharfAttachment extends Attachment {
  url: string;
}

/** Where the browser reads a wharf file: cookie-only, same origin. */
export const wharfFileUrl = (kind: 'documents' | 'dispatches', id: string, file: string): string =>
  `/api/glass/${kind}/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;

/** A wharf document's glass key, and the wharf id behind a key. */
export const documentKey = (doc: Pick<WharfDocument, 'kind' | 'id'>): string => `${doc.kind}:${doc.id}`;
export const wharfId = (key: string): string => key.slice(key.indexOf(':') + 1);

/** The job's one-line title: the first line of its brief. */
const titleOf = (job: Pick<DispatchView, 'brief' | 'id'>): string => job.brief.split('\n')[0]?.trim() || job.id;

/** Wharf states to the glass's buckets. A cancelled job is over, so it is done. */
const bucketOf = (state: DispatchView['state']): GlassDispatchSummary['bucket'] =>
  state === 'queued' ? 'queued' : state === 'active' ? 'active' : 'done';

/** The verb a job shows: its last report's, else queued while it waits, else unknown (never a guess). */
function verbOf(job: DispatchView): GlassDispatchSummary['verb'] {
  if (job.status?.verb) return job.status.verb as GlassDispatchSummary['verb'];
  return job.state === 'queued' ? 'queued' : 'unknown';
}

const attachments = (kind: 'documents' | 'dispatches', id: string, files: readonly WharfFile[]): WharfAttachment[] =>
  files.map((f) => ({ name: f.name, path: '', bytes: f.size, type: '', url: wharfFileUrl(kind, id, f.id) }));

/** One wharf job as a dispatch row. */
export function dispatchSummary(job: DispatchView): GlassDispatchSummary {
  const at = job.status?.at;
  const prUrls = job.status?.evidence?.prUrls ?? [];
  return {
    id: job.id,
    lane: LANE,
    bucket: bucketOf(job.state),
    ...(job.repo ? { repo: job.repo } : {}),
    ...(job.target ? { target: job.target } : {}),
    title: titleOf(job),
    verb: verbOf(job),
    ...((job.status?.note ?? job.unservable?.note) ? { note: job.status?.note ?? job.unservable?.note } : {}),
    ...(at ? { verbAt: at } : {}),
    ...(job.workerId ? { claimedBy: job.workerId } : {}),
    ...(prUrls.length ? { prList: prUrls.map((url) => ({ url, number: prNumber(url) })) } : {}),
    sort: at ? Date.parse(at) : 0,
  };
}

/** A PR's number from its URL, or 0 when the URL names none. */
const prNumber = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** A job's detail as the dispatch modal reads it: the brief, its reports as the log, its messages as the inbox. */
export function dispatchDetail(detail: WharfDetail): GlassDispatch {
  const log: StatusEntry[] = detail.reports.map((r) => ({
    at: r.at,
    verb: r.verb as StatusEntry['verb'],
    ...(r.note ? { note: r.note } : {}),
    ...(r.waitingOn ? { waitingOn: r.waitingOn as StatusEntry['waitingOn'] } : {}),
    ...(r.until ? { until: r.until } : {}),
  }));
  // A summary's evidence is a summary; the full record carries none until the wharf sends one.
  const { evidence: _summary, ...summary } = dispatchSummary(detail);
  return {
    ...summary,
    brief: detail.brief,
    attachments: attachments('dispatches', detail.id, detail.files),
    messageAttachments: [],
    log,
    inbox: detail.messages.map((m) => m.text),
  };
}

/** A worker as a trap row: its boat, harness, session and the command that joins its pane. */
export function trapOf(worker: Worker): GlassTrap {
  const command = attachCommand(worker);
  return {
    trapId: worker.id,
    live: worker.live,
    ...(worker.harness ? { harness: worker.harness as GlassTrap['harness'] } : {}),
    ...(worker.session ? { sessionId: worker.session } : {}),
    ...(worker.repoRemote ? { repo: worker.repoRemote.split('/').pop() } : {}),
    heartbeatAt: worker.lastCheckIn,
    label: `${worker.id} · ${worker.boatName}`,
    ...(command ? { attachCommand: command } : {}),
    messages: [],
    notices: [],
    catches: [],
  };
}

/** A decision document as the deck's card. Its detail is the Markdown the wharf holds, read once (files never change). */
export function decisionOf(doc: WharfDocument, detail: string | undefined): GlassDecision {
  return {
    key: documentKey(doc),
    title: doc.title,
    detail: detail ?? '',
    options: doc.options ?? [],
    attachments: attachments('documents', doc.id, doc.attachments),
    ...(doc.dispatch ? { dispatch: doc.dispatch, lane: LANE } : {}),
    askedBy: doc.author,
    askedAt: doc.at,
    stateHash: `${doc.id}:${doc.answer?.at ?? ''}:${doc.withdrawn ? 'withdrawn' : ''}`,
  };
}

/** A report document as a report row. */
export function reportOf(doc: WharfDocument): GlassReport {
  return {
    key: documentKey(doc),
    title: doc.title,
    author: doc.author,
    filedAt: doc.at,
    stateHash: `${doc.id}:${doc.ack?.at ?? ''}`,
    ...(doc.ack ? { acked: doc.ack } : {}),
    ...(doc.dispatch ? { dispatch: doc.dispatch, lane: LANE } : {}),
    bytes: doc.markdown?.size ?? 0,
    attachments: attachments('documents', doc.id, doc.attachments),
  };
}

/** A review document as a review row: the round, who asked, and the link that opens it in the review tool. */
export function reviewOf(doc: WharfDocument): GlassReview | undefined {
  const r = doc.review;
  if (!r) return undefined;
  return {
    key: documentKey(doc),
    url: r.pr,
    reviewUrl: r.open ?? r.pr,
    repo: /github\.com\/([^/]+\/[^/]+)\/pull/.exec(r.pr)?.[1] ?? '',
    number: prNumber(r.pr),
    title: doc.title,
    author: doc.author,
    ...(r.requestedBy ? { requestedBy: r.requestedBy } : {}),
    requestedAt: doc.at,
    state: r.state as GlassReview['state'],
    stands: !!r.stands,
    ...(r.reason ? { reason: r.reason } : {}),
    headSha: r.headSha ?? '',
    prHeadSha: r.headSha ?? '',
  };
}

/** The deck's attention: standing decisions, jobs waiting on a person, and recent landings. */
function attentionOf(glass: WharfGlass, jobs: readonly DispatchView[], now: number): TendAttention[] {
  const age = (at: string | undefined) => (at ? Math.max(0, Math.round((now - Date.parse(at)) / 1000)) : 0);
  const decisions = glass.documents
    .filter((d) => d.kind === 'decision' && d.published && !d.withdrawn && !d.answer)
    .map((d): TendAttention => ({
      kind: 'decision',
      key: documentKey(d),
      stateHash: decisionOf(d, undefined).stateHash,
      id: d.dispatch ?? d.id,
      lane: LANE,
      verb: 'needs-decision',
      ageSecs: age(d.at),
      at: d.at,
      note: d.title,
    }));
  const questions = jobs
    .filter((j) => j.state === 'active' && (j.status?.verb === 'needs-decision' || j.status?.verb === 'blocked'))
    .map((j): TendAttention => ({
      kind: 'question',
      key: `${LANE}:${j.id}`,
      stateHash: `${j.id}:${j.status!.at}`,
      id: j.id,
      lane: LANE,
      verb: j.status!.verb,
      ageSecs: age(j.status!.at),
      at: j.status!.at,
      ...(j.status!.note ? { note: j.status!.note } : {}),
      ...(j.repo ? { repo: j.repo } : {}),
    }));
  return [...decisions, ...questions];
}

/** Jobs that finished within the landed window, newest first. */
function landedOf(jobs: readonly DispatchView[], now: number): LandedCatch[] {
  return jobs
    .filter((j) => j.state === 'done' && j.status && (j.status.verb === 'done' || j.status.verb === 'failed'))
    .filter((j) => now - Date.parse(j.status!.at) <= LANDED_WINDOW_MS)
    .sort((a, b) => b.status!.at.localeCompare(a.status!.at))
    .map((j) => ({
      key: `${LANE}:${j.id}`,
      id: j.id,
      lane: LANE,
      verb: j.status!.verb as LandedCatch['verb'],
      at: j.status!.at,
      ...(j.status!.note ? { note: j.status!.note } : {}),
      ...(j.repo ? { repo: j.repo } : {}),
      ...(j.status!.evidence?.prUrls?.[0] ? { prUrl: j.status!.evidence.prUrls[0] } : {}),
      unreported: false,
    }));
}

/**
 * The account as one snapshot. `details` holds the decision Markdown read so
 * far, by file id. `token` marks the page as able to write: the wharf
 * authorizes each write by its cookie and same-origin rules, not by it.
 */
export function wharfSnapshot(
  glass: WharfGlass,
  jobs: readonly DispatchView[],
  now: number,
  details: ReadonlyMap<string, string>,
  token: string,
): GlassSnapshot {
  const docs = glass.documents.filter((d) => d.published);
  return {
    now: new Date(now).toISOString(),
    version: '',
    repoUrl: 'https://github.com/aequitas-labs/lobstah',
    focusToken: token,
    helms: [],
    traps: glass.workers.map(trapOf),
    notices: [],
    watches: [],
    dispatches: jobs.map(dispatchSummary).sort((a, b) => b.sort - a.sort),
    prs: [],
    stacks: [],
    attention: attentionOf(glass, jobs, now),
    landed: landedOf(jobs, now),
    decisions: docs
      .filter((d) => d.kind === 'decision' && !d.withdrawn)
      .map((d) => decisionOf(d, d.markdown ? details.get(d.markdown.id) : undefined)),
    reports: docs.filter((d) => d.kind === 'report').map(reportOf),
    reviews: docs.flatMap((d) => (d.kind === 'review' ? (reviewOf(d) ?? []) : [])),
    attentionKinds: WHARF_ATTENTION_KINDS,
  };
}
