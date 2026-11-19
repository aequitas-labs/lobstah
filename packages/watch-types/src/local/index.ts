import { BaseWatchType } from '../base.js';
import { CommandWatchType, watchStringSchema } from '../command.js';
import { watchJson } from '../registry.js';
import type {
  WatchContext,
  WatchDerivation,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
  WatchTypeDescriptor,
  WatchNoticePolicy,
} from '../model.js';

/** Local sources checkpoint their standing conditions; their existing logs retain wake cursors. */
export interface LocalSignalState {
  suppresses?: WatchPresentation['suppresses'];
  conditions: WatchPresentation['attention'];
  rows: WatchPresentation['rows'];
}
export interface LocalSignalReference {
  scope: string;
}
export type LocalSignalSnapshot = WatchSnapshot<LocalSignalReference, LocalSignalState, string, Record<string, never>>;
export interface LocalSignalSpecification {
  id: string;
  label: string;
  worker: string[];
  helm: string[];
  kinds: NonNullable<WatchTypeDescriptor['attentionKinds']>;
}
export interface LocalSignalServices {
  noticePolicy?: WatchNoticePolicy;
  read(now: string): LocalSignalState;
  revision(state: LocalSignalState): string;
}

/** Presentation and instructions travel with the local source rather than a helm kind switch. */
export function presentLocalSignals(specification: LocalSignalSpecification, state: LocalSignalState): WatchPresentation {
  return {
    listing: 'conditions',
    title: specification.label,
    label: specification.label,
    summary: state.conditions.map((condition) => condition.summary).join('; '),
    tone: state.conditions.some((condition) => condition.blocking) ? 'warning' : 'neutral',
    worker: { steps: specification.worker },
    helm: { steps: specification.helm },
    rows: state.rows,
    links: [],
    actions: [],
    attention: state.conditions,
    ...(state.suppresses ? { suppresses: state.suppresses } : {}),
  };
}

/** Status, decisions, reports and notices compose this base adapter with their own durable readers. */
export class LocalSignalWatchType extends BaseWatchType<LocalSignalReference, LocalSignalState, string, Record<string, never>> {
  readonly descriptor: WatchTypeDescriptor;
  readonly bindings = [{ event: 'local' as const, field: 'records' }];
  private readonly command = new CommandWatchType();
  readonly optionsSchema = this.command.stateSchema;
  readonly cursorSchema = watchStringSchema;
  readonly referenceSchema: WatchSchema<LocalSignalReference> = {
    json: { type: 'object', required: ['scope'], properties: { scope: { type: 'string' } } },
    parse(value) {
      if (!value || typeof value !== 'object' || !('scope' in value) || typeof value.scope !== 'string' || !value.scope)
        throw new Error('Invalid local signal scope');
      return { scope: value.scope };
    },
  };
  readonly stateSchema: WatchSchema<LocalSignalState> = {
    json: { type: 'object', required: ['conditions', 'rows'], properties: { conditions: { type: 'array' }, rows: { type: 'array' } } },
    parse(value) {
      watchJson(value);
      if (
        !value ||
        typeof value !== 'object' ||
        !('conditions' in value) ||
        !Array.isArray(value.conditions) ||
        !('rows' in value) ||
        !Array.isArray(value.rows)
      )
        throw new Error('Invalid local signal state');
      const state = value as LocalSignalState;
      if (
        state.conditions.some(
          (condition) =>
            !condition ||
            typeof condition.id !== 'string' ||
            typeof condition.kind !== 'string' ||
            typeof condition.stateHash !== 'string' ||
            typeof condition.summary !== 'string' ||
            typeof condition.quiet !== 'boolean' ||
            typeof condition.blocking !== 'boolean',
        )
      )
        throw new Error('Invalid local signal condition');
      if (state.rows.some((row) => typeof row?.label !== 'string' || typeof row.value !== 'string'))
        throw new Error('Invalid local signal row');
      if (
        state.suppresses !== undefined &&
        (!Array.isArray(state.suppresses) ||
          state.suppresses.some((rule) => !rule || typeof rule.key !== 'string' || typeof rule.kind !== 'string'))
      )
        throw new Error('Invalid local signal suppression');
      return state;
    },
  };
  readonly noticePolicy: WatchNoticePolicy | undefined;
  readonly derived: WatchDerivation;
  constructor(
    readonly specification: LocalSignalSpecification,
    private readonly services: LocalSignalServices,
  ) {
    super();
    this.noticePolicy = services.noticePolicy;
    this.descriptor = { id: specification.id, keyPrefix: `${specification.id}:`, apiVersion: 1, stateVersion: 1, version: '1.0.0', attentionKinds: specification.kinds };
    this.derived = {
      views: (now) => {
        const state = this.stateSchema.parse(services.read(now));
        return [
          {
            key: `${specification.id}:home`,
            input: 'home',
            options: {},
            owner: { kind: 'helm', grounds: 'home' },
            revision: services.revision(state),
            since: state.conditions[0]?.since ?? now,
            presentation: presentLocalSignals(specification, state),
          },
        ];
      },
    };
  }
  identify(input: string): LocalSignalReference {
    return { scope: input.replace(new RegExp(`^${this.descriptor.id}:`), '') };
  }
  key(reference: LocalSignalReference): string {
    return `${this.descriptor.id}:${reference.scope}`;
  }
  initialize() {
    return { state: { conditions: [], rows: [] }, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): LocalSignalSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1)
      throw new Error(`${this.specification.label} state version is unsupported`);
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll({ now }: WatchContext<LocalSignalReference, LocalSignalState, string, Record<string, never>>): WatchObservationBatch<string> {
    const state = this.stateSchema.parse(this.services.read(now));
    return { cursor: this.services.revision(state), events: [], payload: watchJson(state) };
  }
  reduce(snapshot: LocalSignalSnapshot, batch: WatchObservationBatch<string>) {
    return {
      state: batch.payload === undefined ? snapshot.state : this.stateSchema.parse(batch.payload),
      cursor: batch.cursor,
      done: false,
    };
  }
  present(snapshot: LocalSignalSnapshot) {
    return presentLocalSignals(this.specification, snapshot.state);
  }
  failure(error: unknown) {
    return {
      kind: 'local',
      message: error instanceof Error ? error.message : String(error),
      remedy: `Restore compatible ${this.specification.label.toLowerCase()} records or install the matching adapter, then release the watch.`,
    };
  }
  close(): void {
    /* The durable source records and their acknowledgment cursors remain source-owned. */
  }
}
