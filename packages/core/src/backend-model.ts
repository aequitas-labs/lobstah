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
/**
 * Every family of card the glass shows, local or hosted. One card is one
 * item: a decision, a worker's raw question at one status, a permission
 * request, a job's progress, a landing, a PR or stack, a review, a report,
 * a notice or watch, a trap, a boat, or a person's request.
 */
export const GLASS_CARD_FAMILIES = ['decision', 'question', 'permission', 'dispatch', 'landed', 'pr', 'stack', 'review', 'report', 'notice', 'trap', 'boat', 'request'] as const;
export type GlassCardFamily = (typeof GLASS_CARD_FAMILIES)[number];
/** Where a card's state is authoritative: the wharf's own records, or one boat's local glass. */
export type GlassCardSource = 'wharf' | `boat:${string}`;
/**
 * What a person can do from a card, as the card offers it. A card only names
 * an action; each one commits through its own authorized path, and a person
 * seeing a card (`seen`) never answers, grants or dismisses anything.
 */
export type GlassCardAction =
  | { kind: 'answer'; option: string }
  | { kind: 'answer-text' }
  | { kind: 'allow-once' }
  | { kind: 'allow-always' }
  | { kind: 'deny' }
  | { kind: 'seen' }
  | { kind: 'message-helm' }
  | { kind: 'cancel' }
  | { kind: 'review-dismiss' };
export interface GlassCardLink { label: string; url: string }
/** A card that no longer stands: who or what ended it, and how. */
export interface GlassCardTerminal {
  state: 'answered' | 'withdrawn' | 'resolved' | 'landed' | 'cancelled' | 'expired' | 'fulfilled';
  at: string;
  by?: string;
  outcome?: string;
}
/** The glass page a card opens to, with its full detail and files. */
export interface GlassCardItem { kind: 'decision' | 'report' | 'review' | 'job' | 'trap'; id: string }
/** What a source says about one card: the boat's published form, and the wharf's own. */
export interface GlassCardInput {
  family: GlassCardFamily;
  /** The source's own stable key for the item (a tend key, a record id). */
  key: string;
  /** Changes exactly when what the card stands on changes. */
  stateHash: string;
  /** When the source observed this state. */
  sourceAt: string;
  title: string;
  summary?: string;
  grounds?: string;
  links?: GlassCardLink[];
  actions?: GlassCardAction[];
  /** Progress with no current human action. It updates its card; it does not ask for attention. */
  quiet?: boolean;
  /** A person saw this exact state, as the source records it. */
  seen?: WharfAck;
  terminal?: GlassCardTerminal;
}
/**
 * The wharf's canonical card. Identity is source + family + key; `id` names
 * it in links. `revision` advances each time `stateHash` changes, so an
 * action or a projection can say exactly which state it was about.
 */
export interface GlassCard extends GlassCardInput {
  id: string;
  source: GlassCardSource;
  revision: number;
  /** When the wharf stored this revision. */
  observedAt: string;
  links: GlassCardLink[];
  actions: GlassCardAction[];
  /** A wharf record's own page in the glass. Boat cards open as the card itself. */
  item?: GlassCardItem;
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
