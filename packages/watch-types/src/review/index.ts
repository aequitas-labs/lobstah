import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import type {
  WatchCommandPolicy,
  WatchRegistrationPolicy,
  WatchAutomation,
  WatchContext,
  WatchEffectHandler,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
} from '../model.js';

/** One configured identity owns review-request reconciliation on this boat. */
export interface ReviewWatchReference {
  key: string;
  identity: string;
}
export type ReviewWatchState = Record<string, never>;
export type ReviewWatchOptions = Record<string, never>;
export type ReviewWatchSnapshot = WatchSnapshot<ReviewWatchReference, ReviewWatchState, string, ReviewWatchOptions>;
export interface ReviewWatchServices {
  observe(context: WatchContext<ReviewWatchReference, ReviewWatchState, string, ReviewWatchOptions>): WatchObservationBatch<string>;
  present(snapshot: ReviewWatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
  effectHandler?: WatchEffectHandler<ReviewWatchReference>;
  automation?: WatchAutomation<ReviewWatchReference, ReviewWatchState, string, ReviewWatchOptions>;
  /** Compatibility queries the host installs (the legacy review records older glasses read). */
  commands?: WatchCommandPolicy;
  /** Keeps the configured identity's watch registered while reviews are enabled. */
  registration?: WatchRegistrationPolicy;
}

/** Remote reconciliation is an authorized effect; local observation remains read-only. */
export class ReviewWatchType extends BaseWatchType<ReviewWatchReference, ReviewWatchState, string, ReviewWatchOptions> {
  readonly descriptor = {
    id: 'review-requests', keyPrefix: 'review-requests:',
    apiVersion: 1 as const,
    stateVersion: 1,
    version: '1.0.0',
    attentionKinds: [{ kind: 'review', label: 'Review request', defaultEnabled: false }],
  };
  readonly bindings = [{ event: 'local' as const, field: 'reviews.identity' }];
  private readonly command = new CommandWatchType();
  readonly stateSchema = this.command.stateSchema;
  readonly optionsSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly referenceSchema: WatchSchema<ReviewWatchReference> = {
    json: { type: 'object', required: ['key', 'identity'], properties: { key: { type: 'string' }, identity: { type: 'string' } } },
    parse(value) {
      if (!value || typeof value !== 'object' || !('identity' in value) || typeof value.identity !== 'string' || !value.identity.trim())
        throw new Error('A review identity is required');
      const identity = value.identity.trim().toLowerCase(),
        key = `review-requests:${encodeURIComponent(identity)}`;
      if (!('key' in value) || value.key !== key) throw new Error('Review watch identity does not match its key');
      return { identity, key };
    },
  };
  readonly effectHandler: ReviewWatchServices['effectHandler'];
  readonly automation: ReviewWatchServices['automation'];
  readonly commands: ReviewWatchServices['commands'];
  readonly registration: ReviewWatchServices['registration'];
  constructor(private readonly services: ReviewWatchServices) {
    super();
    this.effectHandler = services.effectHandler;
    this.automation = services.automation;
    this.commands = services.commands;
    this.registration = services.registration;
  }
  identify(input: string): ReviewWatchReference {
    const identity = (input.startsWith('review-requests:') ? decodeURIComponent(input.slice('review-requests:'.length)) : input)
      .trim()
      .toLowerCase();
    return this.referenceSchema.parse({ identity, key: `review-requests:${encodeURIComponent(identity)}` });
  }
  key(reference: ReviewWatchReference): string {
    return reference.key;
  }
  initialize() {
    return { state: {}, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): ReviewWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Review watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(context: WatchContext<ReviewWatchReference, ReviewWatchState, string, ReviewWatchOptions>): WatchObservationBatch<string> {
    return this.services.observe(context);
  }
  reduce(_snapshot: ReviewWatchSnapshot, batch: WatchObservationBatch<string>) {
    return { state: {}, cursor: batch.cursor, done: batch.done === true };
  }
  present(snapshot: ReviewWatchSnapshot): WatchPresentation {
    return this.services.present(snapshot);
  }
  failure(error: unknown): WatchFailure {
    return this.services.failure(error);
  }
  close(): void {
    /* Review history is retained independently of the observer. */
  }
}
