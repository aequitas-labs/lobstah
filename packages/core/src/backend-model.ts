/** Portable coordination records. No filesystem, service or runtime imports. */
export type BackendVerb = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed';
export type BackendWait = 'review' | 'pr' | 'deploy' | 'person' | 'external';
export interface DispatchInput {
  id: string; repo: string; repoRemote?: string; brief: string; lane?: 'work' | 'chore';
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
export interface DispatchView extends DispatchInput {
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
