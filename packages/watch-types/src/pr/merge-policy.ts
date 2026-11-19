import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import type { WatchAutomation, WatchContext, WatchEffectHandler, WatchObservationBatch, WatchSchema, WatchSnapshot } from '../model.js';

/** A configured approval policy names its provider without persisting credentials. */
export interface MergePolicyReference {
  name: string;
}
export type MergePolicySnapshot = WatchSnapshot<MergePolicyReference, Record<string, never>, string, Record<string, never>>;
export interface MergePolicyWatchServices {
  revision?: () => string;
  automation?: WatchAutomation<MergePolicyReference, Record<string, never>, string, Record<string, never>>;
  effectHandler?: WatchEffectHandler<MergePolicyReference>;
}

/** Provider IO and merge policy are composed by the host; the generic loop runs this contract. */
export class MergePolicyWatchType extends BaseWatchType<MergePolicyReference, Record<string, never>, string, Record<string, never>> {
  readonly descriptor = { id: 'merge-policy', keyPrefix: 'merge-policy:', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly bindings = [{ event: 'local' as const, field: 'pickup.merge' }];
  private readonly command = new CommandWatchType();
  readonly stateSchema = this.command.stateSchema;
  readonly optionsSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly referenceSchema: WatchSchema<MergePolicyReference> = {
    json: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    parse(value) {
      if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string' || !value.name.trim())
        throw new Error('Invalid merge policy identity');
      return { name: value.name };
    },
  };
  readonly automation: MergePolicyWatchServices['automation'];
  readonly effectHandler: MergePolicyWatchServices['effectHandler'];
  constructor(private readonly services: MergePolicyWatchServices = {}) {
    super();
    this.automation = services.automation;
    this.effectHandler = services.effectHandler;
  }
  identify(input: string): MergePolicyReference {
    return this.referenceSchema.parse({ name: input.replace(/^merge-policy:/, '') });
  }
  key(reference: MergePolicyReference): string {
    return `merge-policy:${reference.name}`;
  }
  initialize() {
    return { state: {}, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): MergePolicySnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Merge policy state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(_context: WatchContext<MergePolicyReference, Record<string, never>, string, Record<string, never>>) {
    return { cursor: this.services.revision?.() ?? 'unconfigured', events: [] };
  }
  reduce(_snapshot: MergePolicySnapshot, batch: WatchObservationBatch<string>) {
    return { state: {}, cursor: batch.cursor, done: false };
  }
  present(snapshot: MergePolicySnapshot) {
    return {
      title: snapshot.reference.name,
      summary: 'Configured approval policy',
      label: 'Merge policy',
      tone: 'neutral' as const,
      worker: {
        steps: ['Keep current-head approval and branch protection checks in place. A watch observation does not authorize a merge.'],
      },
      helm: {
        steps: [
          'This source advances only under its configured approval policy. Inspect any submission with an unknown result before retrying.',
        ],
      },
      rows: [],
      links: [],
      attention: [],
      actions: [{ id: 'reconcile', label: 'Reconcile configured merges', automatic: true, requiresAuthority: true }],
    };
  }
  failure(error: unknown) {
    return { kind: 'merge-policy', message: error instanceof Error ? error.message : String(error) };
  }
  close(): void {
    /* Standing configuration and source request records are retained. */
  }
}
