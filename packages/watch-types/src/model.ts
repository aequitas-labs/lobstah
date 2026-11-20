import type { WatchAttentionDisplay } from './presentation.js';
import type { WatchGlyph, WatchItem, WatchPresentationVersion, WatchSourceBrand, WatchSurface } from './items.js';
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

/** The durable record pins execution identity and capability grants, without environment values. */
export interface WatchPluginInstallation {
  kind: 'process';
  protocolVersion: 1;
  identity: string;
  executable: string;
  version: string;
  envAllow: string[];
  capabilities: string[];
}

/** Protocol compatibility, state layout and adapter release evolve separately. */
export interface WatchTypeDescriptor {
  installation?: WatchPluginInstallation;
  id: string;
  /** Canonical key namespace; absent on older installations and arbitrary command transports. */
  keyPrefix?: string;
  apiVersion: 1;
  stateVersion: number;
  version: string;
  /** Source kind registration, including defaults, travels with stored observations. */
  attentionKinds?: Array<{ kind: string; label: string; defaultEnabled: boolean }>;
}

/** Registration is data interpreted by the registry, never a consumer prefix branch. */
export interface WatchRegistrationBinding {
  event: 'explicit' | 'report' | 'turn-wait' | 'local' | 'legacy-command';
  /** Trusted adapter pattern used only for the one-time legacy command import. */
  pattern?: string;
  /** A matching legacy binding may import this transport type without dropping receipts. */
  importsType?: string;
  field: string;
}

/** Adapters interpret registration fields after their declared bindings match. */
export interface WatchRegistrationRequest {
  event: WatchRegistrationBinding['event'];
  fields: Record<string, WatchValue>;
  owner: WatchOwner;
  options: WatchValue;
  cwd?: string;
  cursor?: string;
  everySecs?: number;
}
export interface WatchRegistrationPlan {
  input: string;
  options: WatchValue;
}
/** Registration and reconciliation belong to the source in either host. */
export interface WatchRegistrationPolicy {
  prepare(request: WatchRegistrationRequest): WatchRegistrationPlan | undefined;
  registered?(request: WatchRegistrationRequest, snapshot: WatchSnapshot): void;
  sync?(now: string, phase: 'before-observe' | 'after-observe' | 'report'): void;
}

/** Optional adapter commands retain compatibility entry points without host source branches. */
export interface WatchCommandRequest {
  name: string;
  args: string[];
  flags: Record<string, string | string[] | boolean>;
}
export interface WatchCommandPolicy {
  bindings: ReadonlyArray<{ name: string; pattern?: string }>;
  run(request: WatchCommandRequest): WatchResult<string>;
}

/** Todo conditions are parsed and read by the source that owns their records. */
export interface WatchTriggerReference { key: string; on: string }
export type WatchTriggerReading = { state: 'waiting' } | { state: 'lost' } | { state: 'met'; as: string };
export interface WatchTriggerPolicy {
  parse(subject: string, condition?: string): WatchTriggerReference | undefined;
  read(reference: WatchTriggerReference, since: string): WatchTriggerReading;
  prepare?(reference: WatchTriggerReference): void;
  needsWatch?(reference: WatchTriggerReference): boolean;
  watchNote?(reference: WatchTriggerReference): string;
}

/** A source can retain an acknowledgement through a stable revision or own an older item key. */
export interface WatchAcknowledgement { key: string; kind: string; stateHash: string }
export interface WatchAcknowledgementPolicy {
  patterns: readonly string[];
  exists(key: string, culling: readonly string[]): boolean | undefined;
  retain(acknowledgement: WatchAcknowledgement, standing: WatchValue | undefined): boolean;
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
  /** A shared provider claim or budget prevented observation; progress stays untouched. */
  deferred?: boolean;
  /** Source checkpoint data for a pure reducer, separate from owner-delivered events. */
  payload?: WatchValue;
}

/** Source-independent retry advice; provider budgets remain adapter-owned. */
export interface WatchFailure {
  /** A provider-wide outage is reported without a per-watch failure streak. */
  shared?: boolean;
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
  /** Automatic actions are scheduler capabilities, not human card controls. */
  automatic?: boolean;
  /** Presentation v2: the JSON schema an item effect's arguments must satisfy; absent means no arguments. */
  arguments?: Record<string, WatchValue>;
}

/**
 * Human and agent consumers share a provider-free presentation model.
 * Version 1 is the original shape. Version 2 adds the source brand and the
 * items a watch yields, with lifecycle, workflow statuses, attention and
 * notification as separate typed axes (items.ts). The version is persisted
 * with the cached presentation, so restoring a view never needs a running
 * plugin. The watch-level `tone` remains the badge of the watch's own
 * condition; items never carry a tone.
 */
export interface WatchPresentation {
  /** Absent on version 1 presentations. */
  version?: WatchPresentationVersion;
  /** Version 2: the source's stable ID, display name and logo. */
  source?: WatchSourceBrand;
  /** Version 2: the review requests, artifacts or other items this watch yields. */
  items?: WatchItem[];
  /** Version 2: the surfaces this source contributes to, even while it has no items (its health shows there). */
  surfaces?: WatchSurface[];
  /** Version 2: the watch's own kind glyph on its Watches card (a PR, a document, a bell). */
  glyph?: WatchGlyph;
  /** Local condition sources can omit a redundant watch row while retaining their card projection. */
  listing?: 'watch' | 'conditions';
  /** Source-owned relationships can suppress another standing condition without a hidden card. */
  suppresses?: Array<{ kind: string; key: string }>;
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
    /** A migrated source can preserve its existing attention identity and wire fields. */
    key?: string;
    fields?: Record<string, WatchValue>;
    kind: string;
    stateHash: string;
    /** The condition began at this time; equal hashes retain it across polls. */
    since?: string;
    summary: string;
    quiet: boolean;
    blocking: boolean;
    presentation?: WatchAttentionDisplay;
  }>;
}

/** An outbox receipt is committed with the event before external delivery. */
export interface WatchDelivery {
  id: string;
  eventIds: string[];
  status: 'pending' | 'delivered';
  continuationId?: string;
  /** Source delivery policy is replayed with the reserved continuation after enqueue. */
  dispatchPlan?: WatchDispatchPlan;
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
  closeReason?: WatchCloseReason;
  events: WatchObservation[];
  deliveries: WatchDelivery[];
  deliveryProgress?: WatchDeliveryProgress;
  actionReceipts?: WatchActionReceipt[];
  presentation: WatchPresentation;
  createdAt: string;
  /** When the last check attempt began; stamped before observation, so it is not proof of success. */
  checkedAt?: string;
  /** When an observation last completed without a failure. */
  lastSuccessAt?: string;
  failure?: WatchFailure;
  failures: number;
  lease?: { token: string; until: number };
  /** Independent stream ownership; polling and streaming publish through the same observation lease. */
  subscriptionLease?: { token: string; until: number };
}

export interface WatchContext<Reference, State, Cursor, Options> {
  snapshot: WatchSnapshot<Reference, State, Cursor, Options>;
  now: string;
  /** Runtime cadence is available to provider batch budget calculations. */
  everySecs?: number;
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
  /** The host attaches its claimed durable generation before invoking an effect. */
  generation?: string;
  id: string;
  actionId: string;
  reference: Reference;
  expectedRevision: string;
  authorization: { id: string; by: string; at: string };
  arguments: WatchValue;
}

/** Source handlers own effect semantics; the runtime owns receipts and authorization. */
export interface WatchEffectHandler<Reference> {
  /** Hosts reject an incompatible execution mode before invoking the handler. */
  execution: 'sync' | 'async';
  execute(request: WatchActionRequest<Reference>): WatchResult<WatchEffectResult>;
}

/** Delivery policy chooses work; transport owns queuing and durable receipts. */
export interface WatchDispatchPlan {
  disposition: 'continue' | 'managed' | 'ignore';
  eventIds: string[];
  notes: string[];
  state?: WatchValue;
}
export interface WatchDispatchContext<Reference, State, Cursor, Options> extends WatchContext<Reference, State, Cursor, Options> {
  events: WatchObservation[];
  repo?: string;
}
export interface WatchDispatchPolicy<Reference, State, Cursor, Options> {
  plan(context: WatchDispatchContext<Reference, State, Cursor, Options>): WatchDispatchPlan;
  prepareBrief?(context: WatchDispatchContext<Reference, State, Cursor, Options>, filled: string): string;
  delivered?(context: WatchDispatchContext<Reference, State, Cursor, Options>, plan: WatchDispatchPlan, workId: string): void;
}

/** Automatic proposals name the existing configuration authority that permits them. */
export interface WatchActionProposal {
  actionId: string;
  expectedRevision: string;
  idempotencyKey: string;
  authority: string;
  /** Existing human requests retain their original provenance in the generic receipt. */
  by?: string;
  authorizedAt?: string;
  arguments: WatchValue;
}
export interface WatchAutomation<Reference, State, Cursor, Options> {
  propose(context: WatchContext<Reference, State, Cursor, Options>): WatchActionProposal[];
}
/** A bounded action history retains replay receipts without growing with every poll. */
export interface WatchActionReceipt {
  request: WatchActionRequest<WatchValue>;
  idempotencyKey: string;
  generation: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  lease?: { token: string; until: number };
  /** Independent stream ownership; polling and streaming publish through the same observation lease. */
  subscriptionLease?: { token: string; until: number };
  result?: WatchEffectResult;
  failure?: WatchFailure;
}
/** Effects return concrete scheduler IDs, so the generic host can enforce its work cap. */
export interface WatchEffectResult {
  workIds: string[];
  data?: WatchValue;
}
/** Delivery scheduling is runtime state, separate from a source’s cursor and reducer state. */
export interface WatchDeliveryProgress {
  lastFollowUpId?: string;
  seenAt?: number;
  heldAt?: string;
  heldReason?: string;
  heldFor?: string;
  heldBy?: string;
}

/** Composition roots install source passes; the host invokes them without source branches. */
export interface WatchSourcePass {
  label: string;
  run(): WatchResult<void>;
}

/** Derived views use cached observations only; rendering performs no provider IO or writes. */
export interface WatchDerivedView {
  key: string;
  input: string;
  options: WatchValue;
  owner: WatchOwner;
  revision: string;
  since: string;
  presentation: WatchPresentation;
}
export interface WatchDerivation { views(now: string): WatchDerivedView[] }

/** Durable notice filtering and ownership are source policy, independent of the helm wake loop. */
export interface WatchNotice {
  kind: string;
  refId?: string;
  url?: string;
  stateHash?: string;
}
export interface WatchNoticePolicy {
  kinds: readonly string[];
  quietKinds?: readonly string[];
  current(notice: WatchNotice): boolean;
  relatedDispatches?(notice: WatchNotice): string[];
}
