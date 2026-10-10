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
export interface DispatchView extends DispatchInput {
  state: 'queued' | 'active' | 'done' | 'cancelled'; status?: BackendStatus;
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
export interface WharfDocumentInput {
  id: string; kind: 'decision' | 'report'; title: string; options?: string[]; dispatch?: string;
}
export interface WharfDocument extends WharfDocumentInput {
  at: string; author: string; published: boolean; withdrawn?: boolean;
  markdown?: WharfFile; attachments: WharfFile[];
  answer?: { option?: string; text?: string; at: string; by: string };
}
export interface WharfHumanRequest {
  id: string; kind: 'message' | 'trap-request'; dispatch?: string; text?: string; boat?: string; repo?: string;
  at: string; expiresAt: string; state: 'queued' | 'received' | 'fulfilled' | 'expired'; by: string;
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
