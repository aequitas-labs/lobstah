/** JSON is the durable and cross-process boundary for every watch type. */
export type WatchValue = null | boolean | number | string | WatchValue[] | { [key: string]: WatchValue };

/** Validation accompanies the JSON schema sent to out-of-process adapters. */
export interface WatchSchema<T> {
  readonly json: Readonly<Record<string, WatchValue>>;
  parse(value: unknown): T;
}

/** Ownership survives a worker session or a trap temporarily signing off. */
export type WatchOwner =
  | { kind: 'helm'; grounds: string }
  | { kind: 'dispatch'; chainId: string; grounds: string }
  | { kind: 'trap'; trapId: string; grounds: string };

/** Protocol compatibility, state layout and adapter release evolve separately. */
export interface WatchTypeDescriptor {
  id: string;
  apiVersion: 1;
  stateVersion: number;
  version: string;
}

/** Registration is data interpreted by the registry, never a consumer prefix branch. */
export interface WatchRegistrationBinding {
  event: 'explicit' | 'report' | 'turn-wait' | 'local';
  field: string;
}

/** Provider IDs are stable across polling, streaming and reconnects. */
export interface WatchObservation {
  id: string;
  kind: string;
  at: string;
  summary: string;
  data: WatchValue;
}

/** An explicit partial failure may commit valid observations with its checkpoint. */
export interface WatchObservationBatch<Cursor> {
  cursor: Cursor;
  events: WatchObservation[];
  done?: boolean;
  failure?: WatchFailure;
}

/** Source-independent retry advice; provider budgets remain adapter-owned. */
export interface WatchFailure {
  kind: string;
  message: string;
  remedy?: string;
  retryAfterSecs?: number;
  exitCode?: number;
  hold?: boolean;
}

/** Structured read commands preserve project context without shell interpolation. */
export interface WatchReadCommand {
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
}

/** Source instructions are trusted installed content; event text remains data. */
export interface WatchInstructions {
  steps: string[];
  read?: WatchReadCommand;
}

export interface WatchAction {
  id: string;
  label: string;
  requiresAuthority: boolean;
}

/** Human and agent consumers share a provider-free presentation model. */
export interface WatchPresentation {
  title: string;
  summary: string;
  label: string;
  tone: 'neutral' | 'ok' | 'warning' | 'risk';
  worker: WatchInstructions;
  helm: WatchInstructions;
  rows: Array<{ label: string; value: string }>;
  links: Array<{ label: string; url: string }>;
  actions: WatchAction[];
  attention: Array<{
    id: string;
    kind: string;
    stateHash: string;
    summary: string;
    quiet: boolean;
    blocking: boolean;
  }>;
}

/** An outbox receipt is committed with the event before external delivery. */
export interface WatchDelivery {
  id: string;
  eventIds: string[];
  status: 'pending' | 'delivered';
  continuationId?: string;
}

/** One atomic journal snapshot contains progress, observations and outbox receipts. */
export interface WatchSnapshot<Reference = WatchValue, State = WatchValue, Cursor = WatchValue, Options = WatchValue> {
  key: string;
  type: WatchTypeDescriptor;
  reference: Reference;
  state: State;
  cursor: Cursor;
  options: Options;
  owner: WatchOwner;
  generation: string;
  /** Import provenance for a compatibility registration, never a session ID. */
  originGeneration?: string;
  status: 'watching' | 'draining' | 'closing' | 'retired' | 'held';
  events: WatchObservation[];
  deliveries: WatchDelivery[];
  presentation: WatchPresentation;
  createdAt: string;
  checkedAt?: string;
  failure?: WatchFailure;
  failures: number;
  lease?: { token: string; until: number };
}

export interface WatchContext<Reference, State, Cursor, Options> {
  snapshot: WatchSnapshot<Reference, State, Cursor, Options>;
  now: string;
  signal?: AbortSignal;
}

export interface WatchPlan<State, Cursor> {
  state: State;
  cursor: Cursor;
  done: boolean;
}

export type WatchResult<T> = T | Promise<T>;
export type WatchCloseReason = 'done' | 'removed' | 'owner-finished';

/** Streaming uses the same normalized batches and checkpoints as polling. */
export interface WatchSubscriber<Reference, State, Cursor, Options> {
  subscribe(context: WatchContext<Reference, State, Cursor, Options>): AsyncIterable<WatchObservationBatch<Cursor>>;
}

/** A provider owns grouping and must return a result for every requested key. */
export interface WatchBatchObserver<Reference, State, Cursor, Options> {
  group(context: WatchContext<Reference, State, Cursor, Options>): string;
  pollBatch(
    contexts: readonly WatchContext<Reference, State, Cursor, Options>[],
  ): WatchResult<Record<string, WatchObservationBatch<Cursor> | WatchFailure>>;
}

/** Recorded authority and expected source revision accompany every remote write. */
export interface WatchActionRequest<Reference> {
  id: string;
  actionId: string;
  reference: Reference;
  expectedRevision: string;
  authorization: { id: string; by: string; at: string };
  arguments: WatchValue;
}

/** Source handlers own effect semantics; the runtime owns receipts and authorization. */
export interface WatchEffectHandler<Reference> {
  execute(request: WatchActionRequest<Reference>): WatchResult<WatchValue>;
}
