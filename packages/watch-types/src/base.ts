import type {
  WatchCloseReason,
  WatchContext,
  WatchFailure,
  WatchObservationBatch,
  WatchPlan,
  WatchPresentation,
  WatchRegistrationBinding,
  WatchResult,
  WatchSchema,
  WatchSnapshot,
  WatchTypeDescriptor,
  WatchSubscriber,
  WatchBatchObserver,
  WatchEffectHandler,
  WatchAutomation,
  WatchDispatchPolicy,
} from './model.js';

/** Every source implements policy and presentation as well as observation. */
export abstract class BaseWatchType<Reference, State, Cursor, Options> {
  abstract readonly descriptor: WatchTypeDescriptor;
  abstract readonly referenceSchema: WatchSchema<Reference>;
  abstract readonly stateSchema: WatchSchema<State>;
  abstract readonly cursorSchema: WatchSchema<Cursor>;
  abstract readonly optionsSchema: WatchSchema<Options>;
  /** Optional capabilities are composed with the required source contract. */
  readonly subscriber?: WatchSubscriber<Reference, State, Cursor, Options>;
  readonly batchObserver?: WatchBatchObserver<Reference, State, Cursor, Options>;
  readonly effectHandler?: WatchEffectHandler<Reference>;
  readonly automation?: WatchAutomation<Reference, State, Cursor, Options>;
  readonly dispatchPolicy?: WatchDispatchPolicy<Reference, State, Cursor, Options>;
  abstract readonly bindings: readonly WatchRegistrationBinding[];

  /** Reject unrelated input; return a fully validated source reference. */
  abstract identify(input: string, options: Options): Reference | undefined;
  /** Return the canonical durable identity within this type. */
  abstract key(reference: Reference): string;
  /** Establish the baseline without performing a provider read. */
  abstract initialize(reference: Reference, options: Options): { state: State; cursor: Cursor };
  /** Validate and migrate a stored source state without resetting its cursor. */
  abstract restore(snapshot: WatchSnapshot): WatchSnapshot<Reference, State, Cursor, Options>;
  /** Observe only; provider writes belong to separately authorized actions. */
  abstract poll(context: WatchContext<Reference, State, Cursor, Options>): WatchResult<WatchObservationBatch<Cursor>>;
  /** Pure source policy: decide the next state and terminal condition. */
  abstract reduce(
    snapshot: WatchSnapshot<Reference, State, Cursor, Options>,
    batch: WatchObservationBatch<Cursor>,
  ): WatchPlan<State, Cursor>;
  /** Supply all role instructions and human presentation from persisted state. */
  abstract present(snapshot: WatchSnapshot<Reference, State, Cursor, Options>): WatchPresentation;
  /** Give retry advice without making the runtime recognize a provider. */
  abstract failure(error: unknown): WatchFailure;
  /** Idempotently release source resources after pending deliveries drain. */
  abstract close(context: WatchContext<Reference, State, Cursor, Options>, reason: WatchCloseReason): WatchResult<void>;
}
