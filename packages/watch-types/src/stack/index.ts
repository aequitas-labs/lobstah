import type { WatchNoticePolicy } from '../model.js';
import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import { watchJson } from '../registry.js';
import type {
  WatchAutomation,
  WatchContext,
  WatchDerivation,
  WatchEffectHandler,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
  WatchValue,
} from '../model.js';

/** Stack identity survives bottom-first merges; members are observations, not its key. */
export interface StackWatchReference {
  key: string;
  rootKey: string;
}
export interface StackWatchView {
  rootKey: string;
  repo: string;
  title: string;
  summary: string;
  ready: number;
  allReady: boolean;
  active: boolean;
  epoch: number;
  since: string;
  stateHash: string;
  quiet: boolean;
  members: Array<{ key: string; url: string; number: number; headSha: string; title?: string }>;
  fields: Record<string, WatchValue>;
}
export interface StackWatchState {
  view: StackWatchView | null;
}
export type StackWatchOptions = Record<string, never>;
export type StackWatchSnapshot = WatchSnapshot<StackWatchReference, StackWatchState, string, StackWatchOptions>;
export interface StackWatchServices {
  noticePolicy?: WatchNoticePolicy;
  observe(context: WatchContext<StackWatchReference, StackWatchState, string, StackWatchOptions>): WatchObservationBatch<string>;
  present(snapshot: StackWatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
  derived: WatchDerivation;
  automation?: WatchAutomation<StackWatchReference, StackWatchState, string, StackWatchOptions>;
  effectHandler?: WatchEffectHandler<StackWatchReference>;
}

/** Normalize the local PR graph into one durable stack view. */
export class StackWatchType extends BaseWatchType<StackWatchReference, StackWatchState, string, StackWatchOptions> {
  readonly descriptor = {
    id: 'stack', keyPrefix: 'stack:',
    apiVersion: 1 as const,
    stateVersion: 1,
    version: '1.0.0',
    attentionKinds: [{ kind: 'stack-ready', label: 'Stack readiness', defaultEnabled: false }],
  };
  readonly bindings = [{ event: 'local' as const, field: 'pr.snapshots' }];
  private readonly command = new CommandWatchType();
  readonly optionsSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly referenceSchema: WatchSchema<StackWatchReference> = {
    json: { type: 'object', required: ['key', 'rootKey'], properties: { key: { type: 'string' }, rootKey: { type: 'string' } } },
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('rootKey' in value) ||
        typeof value.rootKey !== 'string' ||
        !value.rootKey ||
        !('key' in value) ||
        value.key !== `stack:${value.rootKey}`
      )
        throw new Error('Invalid stack watch identity');
      return { key: value.key as string, rootKey: value.rootKey };
    },
  };
  readonly stateSchema: WatchSchema<StackWatchState> = {
    json: { type: 'object', required: ['view'], properties: { view: { type: ['object', 'null'] } } },
    parse(value) {
      watchJson(value);
      if (!value || typeof value !== 'object' || !('view' in value)) throw new Error('Invalid stack watch state');
      if (value.view === null) return { view: null };
      const view = value.view as StackWatchView;
      if (
        !view ||
        typeof view.rootKey !== 'string' ||
        typeof view.repo !== 'string' ||
        typeof view.title !== 'string' ||
        typeof view.summary !== 'string' ||
        !Array.isArray(view.members) ||
        !Number.isSafeInteger(view.ready) ||
        typeof view.allReady !== 'boolean' ||
        typeof view.active !== 'boolean' ||
        !Number.isSafeInteger(view.epoch) ||
        !Number.isFinite(Date.parse(view.since)) ||
        typeof view.stateHash !== 'string' ||
        typeof view.quiet !== 'boolean' ||
        !view.fields
      )
        throw new Error('Invalid stack watch view');
      if (
        view.members.some(
          (member) =>
            typeof member.key !== 'string' ||
            typeof member.url !== 'string' ||
            typeof member.number !== 'number' ||
            typeof member.headSha !== 'string',
        )
      )
        throw new Error('Invalid stack member');
      return { view };
    },
  };
  readonly derived: WatchDerivation;
  readonly noticePolicy: WatchNoticePolicy | undefined;
  readonly automation: StackWatchServices['automation'];
  readonly effectHandler: StackWatchServices['effectHandler'];
  constructor(private readonly services: StackWatchServices) {
    super();
    this.derived = services.derived;
    this.noticePolicy = services.noticePolicy;
    this.automation = services.automation;
    this.effectHandler = services.effectHandler;
  }
  identify(input: string): StackWatchReference {
    const rootKey = input.startsWith('stack:') ? input.slice(6) : input;
    return this.referenceSchema.parse({ rootKey, key: `stack:${rootKey}` });
  }
  key(reference: StackWatchReference): string {
    return reference.key;
  }
  initialize() {
    return { state: { view: null }, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): StackWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Stack watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(context: WatchContext<StackWatchReference, StackWatchState, string, StackWatchOptions>) {
    return this.services.observe(context);
  }
  reduce(snapshot: StackWatchSnapshot, batch: WatchObservationBatch<string>) {
    return {
      state: batch.payload === undefined ? snapshot.state : this.stateSchema.parse({ view: batch.payload }),
      cursor: batch.cursor,
      done: batch.done === true,
    };
  }
  present(snapshot: StackWatchSnapshot) {
    return this.services.present(snapshot);
  }
  failure(error: unknown) {
    return this.services.failure(error);
  }
  close(): void {
    /* Stack observations own no remote subscription resources. */
  }
}
