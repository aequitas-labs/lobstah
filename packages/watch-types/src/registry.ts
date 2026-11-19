import { BaseWatchType } from './base.js';
import type {
  WatchSnapshot,
  WatchValue,
  WatchContext,
  WatchCloseReason,
  WatchTypeDescriptor,
  WatchRegistrationBinding,
  WatchObservationBatch,
  WatchPlan,
  WatchPresentation,
  WatchFailure,
  WatchResult,
  WatchBatchObserver,
  WatchEffectHandler,
  WatchAutomation,
  WatchDispatchPolicy,
  WatchDerivation,
  WatchNoticePolicy,
} from './model.js';

/** Runtime type erasure happens only after each adapter validates its own schemas. */
export interface InstalledWatchType {
  descriptor: WatchTypeDescriptor;
  bindings: readonly WatchRegistrationBinding[];
  batchObserver?: WatchBatchObserver<WatchValue, WatchValue, WatchValue, WatchValue>;
  noticePolicy?: WatchNoticePolicy;
  derived?: WatchDerivation;
  effectHandler?: WatchEffectHandler<WatchValue>;
  automation?: WatchAutomation<WatchValue, WatchValue, WatchValue, WatchValue>;
  dispatchPolicy?: WatchDispatchPolicy<WatchValue, WatchValue, WatchValue, WatchValue>;
  identify(
    input: string,
    options: unknown,
  ): { key: string; reference: WatchValue; state: WatchValue; cursor: WatchValue; options: WatchValue } | undefined;
  restore(snapshot: WatchSnapshot): WatchSnapshot;
  poll(context: WatchContext<WatchValue, WatchValue, WatchValue, WatchValue>): WatchResult<WatchObservationBatch<WatchValue>>;
  reduce(snapshot: WatchSnapshot, batch: WatchObservationBatch<WatchValue>): WatchPlan<WatchValue, WatchValue>;
  present(snapshot: WatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
  close(context: WatchContext<WatchValue, WatchValue, WatchValue, WatchValue>, reason: WatchCloseReason): void | Promise<void>;
}

/** Convert validated DTOs into durable JSON, refusing lossy or executable values. */
export function watchJson(value: unknown): WatchValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(watchJson);
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, watchJson(entry)]));
  }
  throw new Error('Watch data must contain only finite JSON values');
}

/** One registry serves CLI, daemon, pickup and presentation without source matching. */
export class WatchRegistry {
  private readonly types = new Map<string, InstalledWatchType>();

  /** Duplicate IDs and unsupported protocol majors are configuration errors. */
  register<Reference, State, Cursor, Options>(adapter: BaseWatchType<Reference, State, Cursor, Options>): void {
    const { id, apiVersion, stateVersion, version } = adapter.descriptor;
    if (!/^[a-z][a-z0-9.-]*$/.test(id) || apiVersion !== 1 || !Number.isSafeInteger(stateVersion) || stateVersion < 1 || !version) {
      throw new Error('Invalid watch type descriptor');
    }
    for (const method of ['identify', 'key', 'initialize', 'restore', 'poll', 'reduce', 'present', 'failure', 'close'] as const) {
      if (typeof adapter[method] !== 'function') throw new Error(`Watch adapter must implement ${method}`);
    }
    if (
      adapter.effectHandler &&
      (!['sync', 'async'].includes(adapter.effectHandler.execution) || typeof adapter.effectHandler.execute !== 'function')
    )
      throw new Error('Watch effect handler must declare its execution mode');
    const kindNames = new Set(this.attentionKinds().map((kind) => kind.kind));
    for (const kind of adapter.descriptor.attentionKinds ?? []) {
      if (!kind.kind || !kind.label || typeof kind.defaultEnabled !== 'boolean' || kindNames.has(kind.kind))
        throw new Error(`Invalid or duplicate watch attention kind: ${kind.kind}`);
      kindNames.add(kind.kind);
    }
    if (this.types.has(id)) throw new Error(`Watch type already installed: ${id}`);
    const restore = (snapshot: WatchSnapshot) => {
      if (snapshot.type.id !== id || snapshot.type.apiVersion !== apiVersion || snapshot.type.stateVersion > stateVersion)
        throw new Error(`Unsupported stored watch type version: ${snapshot.type.id}`);
      const restored = adapter.restore(structuredClone(snapshot));
      if (restored.type.stateVersion !== stateVersion) throw new Error(`Watch state migration is incomplete: ${id}`);
      return restored;
    };
    this.types.set(id, {
      descriptor: { ...adapter.descriptor },
      bindings: adapter.bindings,
      ...(adapter.noticePolicy ? { noticePolicy: adapter.noticePolicy } : {}),
      ...(adapter.derived ? { derived: { views(now) { return adapter.derived!.views(now); } } } : {}),
      ...(adapter.effectHandler
        ? {
            effectHandler: {
              execution: adapter.effectHandler.execution,
              execute(request) {
                return adapter.effectHandler!.execute({ ...request, reference: adapter.referenceSchema.parse(request.reference) });
              },
            },
          }
        : {}),
      ...(adapter.automation
        ? {
            automation: {
              propose(context) {
                return adapter.automation!.propose({ ...context, snapshot: restore(context.snapshot) });
              },
            },
          }
        : {}),
      ...(adapter.dispatchPolicy
        ? {
            dispatchPolicy: {
              plan(context) {
                return adapter.dispatchPolicy!.plan({ ...context, snapshot: restore(context.snapshot) });
              },
              prepareBrief(context, filled) {
                return adapter.dispatchPolicy!.prepareBrief?.({ ...context, snapshot: restore(context.snapshot) }, filled) ?? filled;
              },
              delivered(context, plan, workId) {
                adapter.dispatchPolicy!.delivered?.({ ...context, snapshot: restore(context.snapshot) }, plan, workId);
              },
            },
          }
        : {}),
      ...(adapter.batchObserver
        ? {
            batchObserver: {
              group(context) {
                return adapter.batchObserver!.group({ ...context, snapshot: restore(context.snapshot) });
              },
              pollBatch(contexts) {
                return adapter.batchObserver!.pollBatch(
                  contexts.map((context) => ({ ...context, snapshot: restore(context.snapshot) })),
                ) as WatchResult<Record<string, WatchObservationBatch<WatchValue>>>;
              },
            },
          }
        : {}),
      identify(input, options) {
        const parsed = adapter.optionsSchema.parse(options);
        const identified = adapter.identify(input, parsed);
        if (identified === undefined) return undefined;
        const reference = adapter.referenceSchema.parse(identified);
        const initial = adapter.initialize(reference, parsed);
        return {
          key: adapter.key(reference),
          reference: watchJson(reference),
          state: watchJson(adapter.stateSchema.parse(initial.state)),
          cursor: watchJson(adapter.cursorSchema.parse(initial.cursor)),
          options: watchJson(parsed),
        };
      },
      restore(snapshot) {
        return restore(snapshot) as WatchSnapshot;
      },
      poll(context) {
        return adapter.poll({ ...context, snapshot: restore(context.snapshot) }) as ReturnType<InstalledWatchType['poll']>;
      },
      reduce(snapshot, batch) {
        const result = adapter.reduce(restore(snapshot), { ...batch, cursor: adapter.cursorSchema.parse(batch.cursor) });
        return {
          ...result,
          state: watchJson(adapter.stateSchema.parse(result.state)),
          cursor: watchJson(adapter.cursorSchema.parse(result.cursor)),
        };
      },
      present(snapshot) {
        return adapter.present(restore(snapshot));
      },
      failure(error) {
        return adapter.failure(error);
      },
      close(context, reason) {
        return adapter.close({ ...context, snapshot: restore(context.snapshot) }, reason);
      },
    });
  }

  /** Sources register their attention names; callers never extend a global union. */
  attentionKinds(): Array<{ typeId: string; kind: string; label: string; defaultEnabled: boolean }> {
    return [...this.types.values()].flatMap((adapter) =>
      (adapter.descriptor.attentionKinds ?? []).map((kind) => ({ typeId: adapter.descriptor.id, ...kind })),
    );
  }

  /** Missing adapters are held by the runtime; their durable records remain intact. */
  get(id: string): InstalledWatchType {
    const adapter = this.types.get(id);
    if (!adapter) throw new Error(`Watch type is not installed: ${id}`);
    return adapter;
  }

  list(): InstalledWatchType[] {
    return [...this.types.values()];
  }
}
