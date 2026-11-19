import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import { parsePrWatchReference, prWatchReferenceSchema } from './index.js';
import type { PrWatchReference } from './index.js';
import type {
  WatchAutomation,
  WatchContext,
  WatchEffectHandler,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchSnapshot,
} from '../model.js';

export type PrMergeWatchState = Record<string, never>;
export type PrMergeWatchOptions = Record<string, never>;
export type PrMergeWatchSnapshot = WatchSnapshot<PrWatchReference, PrMergeWatchState, string, PrMergeWatchOptions>;
export interface PrMergeWatchServices {
  observe(context: WatchContext<PrWatchReference, PrMergeWatchState, string, PrMergeWatchOptions>): WatchObservationBatch<string>;
  present(snapshot: PrMergeWatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
  automation?: WatchAutomation<PrWatchReference, PrMergeWatchState, string, PrMergeWatchOptions>;
  effectHandler?: WatchEffectHandler<PrWatchReference>;
}

/** A standing merge authorization outlives the PR’s observation watch and retargets its successors. */
export class PrMergeWatchType extends BaseWatchType<PrWatchReference, PrMergeWatchState, string, PrMergeWatchOptions> {
  readonly descriptor = { id: 'pr-merge', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly bindings = [{ event: 'local' as const, field: 'pr.mergeRequest' }];
  private readonly command = new CommandWatchType();
  readonly referenceSchema = prWatchReferenceSchema;
  readonly stateSchema = this.command.stateSchema;
  readonly optionsSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly automation: PrMergeWatchServices['automation'];
  readonly effectHandler: PrMergeWatchServices['effectHandler'];
  constructor(private readonly services: PrMergeWatchServices) {
    super();
    this.automation = services.automation;
    this.effectHandler = services.effectHandler;
  }
  identify(input: string): PrWatchReference | undefined {
    return parsePrWatchReference(input.startsWith('pr-merge:') ? `pr:${input.slice(9)}` : input);
  }
  key(reference: PrWatchReference): string {
    return `pr-merge:${reference.owner}/${reference.repo}#${reference.number}`;
  }
  initialize() {
    return { state: {}, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): PrMergeWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('PR merge watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(context: WatchContext<PrWatchReference, PrMergeWatchState, string, PrMergeWatchOptions>) {
    return this.services.observe(context);
  }
  reduce(_snapshot: PrMergeWatchSnapshot, batch: WatchObservationBatch<string>) {
    return { state: {}, cursor: batch.cursor, done: batch.done === true };
  }
  present(snapshot: PrMergeWatchSnapshot) {
    return this.services.present(snapshot);
  }
  failure(error: unknown) {
    return this.services.failure(error);
  }
  close(): void {
    /* The source-owned merge request retains its completion audit. */
  }
}
