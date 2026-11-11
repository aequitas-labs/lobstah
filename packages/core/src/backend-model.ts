/** Portable coordination records. No filesystem, service or runtime imports. */
export type BackendVerb = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed';
export type BackendWait = 'review' | 'pr' | 'deploy' | 'person' | 'external' | 'heavy';
export interface DispatchInput {
  id: string; grounds?: string; repo?: string; target?: import('./configured-trap-model.js').ConfiguredTrapTarget; repoRemote?: string; brief: string; lane?: 'work' | 'chore';
  for?: string; boat?: string; followUp?: string; harness?: string; model?: string; effort?: string;
}
export interface ReportInput {
  verb: BackendVerb; note?: string; waitingOn?: BackendWait; link?: string; until?: string;
  evidence?: { prUrls?: string[]; files?: string[]; commits?: string[] };
}
export interface BackendStatus extends ReportInput { at: string; reported?: true }
/**
 * A person has seen an item: recorded on the wharf, so every boat and the
 * hosted glass agree. Display only; it answers and steers nothing. `by` is
 * `boat:<name>` or `person`.
 */
export interface WharfAck { at: string; by: string }
/** A configured child's retained result, with owned file references for the original catch. */
export interface AssistanceResultView { id: string; state: string; note?: string; files: WharfFile[] }
export interface DispatchView extends DispatchInput {
  assistance?: AssistanceResultView[];
  state: 'queued' | 'active' | 'done' | 'cancelled'; status?: BackendStatus;
  /** The ack of the status this job stands on (`status` is that status's time). A newer report leaves none. */
  ack?: WharfAck & { status: string };
  boatName?: string; unservable?: { repo: string; note: string };
  workerId?: string; claimedBoat?: string;
}
export interface ClaimReceipt {
  dispatch: DispatchInput; epoch?: number; token?: string; leaseUntil?: string;
}
export interface BackendMessage { id: string; text: string; received: boolean }
export interface BackendEvent { cursor: string; kind: string; dispatchId?: string; at: string; note?: string; boatName?: string }
export interface EventBatch { events: BackendEvent[]; cursor: string }
/** Hosted glass records contain IDs and uploaded file metadata, never local paths. */
export interface WharfFile { id: string; name: string; size: number }
/** A review document's PR and round state, kept by the boat that publishes it. */
export interface WharfReviewMeta {
  pr: string; round: string; state: string; requestedBy?: string; headSha?: string; stands?: boolean; reason?: string;
  /** The PR in the repo's review tool, where the staged draft is sent. */
  open?: string;
}
export interface WharfDocumentInput {
  id: string; kind: 'decision' | 'report' | 'review'; title: string; options?: string[]; dispatch?: string;
  /** kind review only. */
  review?: WharfReviewMeta;
}
export interface WharfDocument extends WharfDocumentInput {
  at: string; author: string; published: boolean; withdrawn?: boolean;
  markdown?: WharfFile; attachments: WharfFile[];
  answer?: { option?: string; text?: string; at: string; by: string };
  /** The first ack stands; a published document does not change. */
  ack?: WharfAck;
}
/** What a boat keeps of a wharf decision or report: enough for an attention item, never its content. */
export interface WharfDocumentSummary {
  id: string; kind: 'decision' | 'report'; title: string; at: string; dispatch?: string;
  /** A decision a person has answered: it no longer stands. */
  answered?: true;
  ack?: WharfAck;
}
/** What a person asks of a review document; the boat that published it carries it out. Sending happens in the review tool. */
export const WHARF_REVIEW_REQUEST_KINDS = ['review-dismiss'] as const;
export interface WharfHumanRequest {
  id: string; kind: 'message' | 'trap-request' | (typeof WHARF_REVIEW_REQUEST_KINDS)[number]; dispatch?: string; text?: string; boat?: string; repo?: string;
  /** Review requests: the review document. */
  document?: string;
  at: string; expiresAt: string; state: 'queued' | 'received' | 'authorized' | 'fulfilled' | 'expired'; by: string;
  outcome?: string;
  waitingForHelm?: boolean;
}
/**
 * A mirror boat keeps its fleet on its own local grounds and shows it on the
 * hosted glass: it puts its glass snapshot on the wharf, and carries out the
 * reads and writes the hosted glass relays to it. The wharf keeps only each
 * boat's latest snapshot, and a relayed call only until it expires.
 */
export interface WharfMirrorSnapshot {
  /** The boat's id, and the name the glass labels its rows with. */
  boat: string; name: string;
  /** When the boat put this snapshot. */
  at: string;
  /** A digest of the snapshot's JSON: unchanged when the fleet is. */
  etag: string;
  /** The snapshot's gzip size. */
  bytes: number;
}
/** One read of a mirror boat's local glass: a path the glass reads itself. */
export interface WharfMirrorRead { read: string }
/** One write to a mirror boat's local glass: a `POST /requests` kind and its payload. */
export interface WharfMirrorWrite { write: { kind: MirrorWriteKind; payload: unknown } }
export type WharfMirrorCallInput = { id: string; boat: string; files?: string[] } & (WharfMirrorRead | WharfMirrorWrite);
export const WHARF_MIRROR_CALL_STATES = ['queued', 'taken', 'answered', 'expired'] as const;
export type WharfMirrorCallState = (typeof WHARF_MIRROR_CALL_STATES)[number];
/** A relayed call as the wharf keeps it. Its answer's body is stored apart, and read once it is answered. */
export type WharfMirrorCall = WharfMirrorCallInput & {
  at: string; expiresAt: string; state: WharfMirrorCallState; by: string;
  answer?: { status: number; contentType: string; bytes: number; at: string };
};
/** How long a relayed call waits for its boat. */
export const MIRROR_CALL_MS = 600_000;
/** The largest snapshot a boat may put, gzipped. */
export const MIRROR_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
/** The largest snapshot JSON the wharf unpacks. */
export const MIRROR_SNAPSHOT_MAX_JSON_BYTES = 16 * 1024 * 1024;
/**
 * What the hosted glass may read on a mirror boat: the local glass's own
 * reads (dispatch details, closed decisions, older pages, stats, masked
 * settings, report pages and listed files, checklists). Nothing else.
 */
export const MIRROR_READ_PATHS: readonly RegExp[] = [
  /^\/data\/(stats|settings)$/,
  /^\/data\/dispatch\/[A-Za-z0-9-]{1,64}$/,
  /^\/data\/decision\/[A-Za-z0-9%._-]{1,300}$/,
  /^\/data\/older\?kind=[a-z-]{1,32}&offset=\d{1,6}&limit=\d{1,4}$/,
  /^\/api\/checklist\?key=[A-Za-z0-9%._-]{1,300}$/,
  /^\/report\/[A-Za-z0-9%._-]{1,300}\/(meta|md)$/,
  /^\/(report|decision)\/[A-Za-z0-9%._-]{1,300}\/files\/[A-Za-z0-9%._-]{1,300}$/,
  /^\/attachment\/dispatch\/(work|chore)\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9%._-]{1,300}$/,
  /^\/attachment\/trap\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9%._-]{1,300}$/,
];
/**
 * What the hosted glass may write on a mirror boat: every `POST /requests`
 * kind the local glass takes. Focus is not one: ↗ Open raises a window on
 * the boat's own screen and is never relayed.
 */
export const MIRROR_WRITE_KINDS = [
  'decision-answer', 'decision-viewed', 'report-viewed', 'checklist-tick', 'trap-request', 'helm-chat', 'todo-schedule', 'pr-ack',
  'grant-revoke', 'permissions-proposal-answer', 'permissions-proposal-preview',
  'review-approve', 'review-comment', 'review-dismiss', 'review-draft', 'review-mode', 'review-redraft', 'review-request-changes', 'review-seen', 'review-skip',
  // A phone pairing its passkey with this boat: the boat takes it only under the code it issued, from the hosted glass's origin.
  'run-pair-challenge', 'run-pair-register',
  // A Run from the hosted glass: the boat checks a phone's passkey (or that page's window key) and runs only its stored script.
  'run-challenge', 'run', 'run-output',
] as const;
export type MirrorWriteKind = (typeof MIRROR_WRITE_KINDS)[number];
/** Whether a relayed read names a path the hosted glass may read. */
export function mirrorReadAllowed(path: string): boolean {
  // No climbing out of a segment, written plainly or percent-encoded.
  return path.length <= 700 && !path.includes('..') && !/%2e%2e|%2f|%5c/i.test(path) && MIRROR_READ_PATHS.some((pattern) => pattern.test(path));
}
/** Whether a relayed write names a request kind the hosted glass may send. */
export function mirrorWriteAllowed(kind: unknown): kind is MirrorWriteKind {
  return typeof kind === 'string' && (MIRROR_WRITE_KINDS as readonly string[]).includes(kind);
}
export interface BackendLocation { kind: 'wharf'; url: string; account: string; tokenEnv: string }
export interface CoordinationBackend {
  enqueue(input: DispatchInput, key: string): Promise<DispatchInput>;
  list(): Promise<DispatchView[]>;
  claim(key: string): Promise<ClaimReceipt | null>;
  heartbeat(id: string, key: string): Promise<void>;
  report(id: string, input: ReportInput, key: string): Promise<void>;
  send(id: string, text: string, key: string): Promise<void>;
  messages(id: string): Promise<BackendMessage[]>;
  receipt(id: string, message: string, key: string): Promise<void>;
}
