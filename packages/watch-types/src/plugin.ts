import { createHash } from 'node:crypto';
import { BaseWatchType } from './base.js';
import type {
  WatchAcknowledgementPolicy,
  WatchTriggerPolicy,
  WatchCommandPolicy,
  WatchRegistrationPolicy,
  WatchActionProposal,
  WatchActionRequest,
  WatchAutomation,
  WatchBatchObserver,
  WatchCloseReason,
  WatchContext,
  WatchDerivation,
  WatchDispatchPolicy,
  WatchEffectHandler,
  WatchEffectResult,
  WatchFailure,
  WatchNoticePolicy,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
  WatchSubscriber,
  WatchTypeDescriptor,
  WatchValue,
} from './model.js';
import { WatchPluginTransport } from './plugin-transport.js';
import {
  pluginDto,
  pluginSchema,
  validatePluginManifest,
  validateWatchFailure,
  validateWatchPresentation,
  watchRegistrationPlanSchema,
  watchTriggerReferenceSchema,
  watchTriggerReadingSchema,
  watchActionRequestSchema,
  watchBatchSchema,
  watchEffectResultSchema,
  WatchPluginError,
  watchPluginEnvironment,
  watchPluginIdentity,
} from './plugin-model.js';
import type { WatchPluginConfiguration, WatchPluginContext, WatchPluginManifest } from './plugin-model.js';

const jsonSchema: WatchSchema<WatchValue> = { json: {}, parse: pluginDto };
const stringSchema = { type: 'string' };
const transports = new Map<string, { id: string; transport: WatchPluginTransport }>();
const adapters = new Map<string, ProcessWatchType>();

/** Credentials affect the live connection cache, but their values never enter the durable installation identity. */
function connectionKey(configuration: WatchPluginConfiguration): string {
  return (
    watchPluginIdentity(configuration) +
    ':' +
    createHash('sha256')
      .update(JSON.stringify(watchPluginEnvironment(configuration.envAllow)))
      .digest('hex')
  );
}
function transportFor(configuration: WatchPluginConfiguration): WatchPluginTransport {
  const key = connectionKey(configuration);
  let entry = transports.get(key);
  if (!entry) {
    entry = { id: configuration.id, transport: new WatchPluginTransport(configuration) };
    transports.set(key, entry);
  }
  return entry.transport;
}

/** Tests and hosts can shut down exactly the plugin processes they installed. */
export async function disposeWatchPlugins(id?: string): Promise<void> {
  const disposed: Promise<void>[] = [];
  for (const [key, entry] of transports)
    if (!id || entry.id === id) {
      transports.delete(key);
      for (const adapterKey of adapters.keys()) if (adapterKey.startsWith(key + ':')) adapters.delete(adapterKey);
      disposed.push(entry.transport.dispose());
    }
  await Promise.allSettled(disposed);
}

type PluginContext = WatchContext<WatchValue, WatchValue, WatchValue, WatchValue>;
const actionProposalSchema = {
  type: 'object',
  required: ['actionId', 'expectedRevision', 'idempotencyKey', 'authority', 'arguments'],
  additionalProperties: false,
  properties: {
    actionId: stringSchema,
    expectedRevision: stringSchema,
    idempotencyKey: stringSchema,
    authority: stringSchema,
    arguments: {},
    by: stringSchema,
    authorizedAt: { type: 'string', format: 'date-time' },
  },
};
const dispatchPlanSchema = {
  type: 'object',
  required: ['disposition', 'eventIds', 'notes'],
  additionalProperties: false,
  properties: {
    disposition: { enum: ['continue', 'managed', 'ignore'] },
    eventIds: { type: 'array', items: stringSchema },
    notes: { type: 'array', items: stringSchema },
  },
};

/** A process adapter implements the same required methods; the worker bridge owns only transport and lifecycle. */
export class ProcessWatchType extends BaseWatchType<WatchValue, WatchValue, WatchValue, WatchValue> {
  readonly descriptor: WatchTypeDescriptor;
  readonly bindings: WatchPluginManifest['bindings'];
  readonly referenceSchema: WatchSchema<WatchValue>;
  readonly stateSchema: WatchSchema<WatchValue>;
  readonly cursorSchema: WatchSchema<WatchValue>;
  readonly optionsSchema: WatchSchema<WatchValue>;
  declare readonly acknowledgements?: WatchAcknowledgementPolicy;
  declare readonly triggers?: WatchTriggerPolicy;
  declare readonly commands?: WatchCommandPolicy;
  declare readonly registration?: WatchRegistrationPolicy;
  declare readonly subscriber?: WatchSubscriber<WatchValue, WatchValue, WatchValue, WatchValue>;
  declare readonly batchObserver?: WatchBatchObserver<WatchValue, WatchValue, WatchValue, WatchValue>;
  declare readonly effectHandler?: WatchEffectHandler<WatchValue>;
  declare readonly automation?: WatchAutomation<WatchValue, WatchValue, WatchValue, WatchValue>;
  declare readonly dispatchPolicy?: WatchDispatchPolicy<WatchValue, WatchValue, WatchValue, WatchValue>;
  declare readonly derived?: WatchDerivation;
  declare readonly noticePolicy?: WatchNoticePolicy;
  readonly manifest: WatchPluginManifest;
  private readonly transport: WatchPluginTransport;

  constructor(
    readonly configuration: WatchPluginConfiguration,
    defaults: Record<string, unknown> = {},
  ) {
    super();
    this.transport = transportFor(configuration);
    this.manifest = validatePluginManifest(
      this.transport.callSync('watch.handshake', {}, { deadline: Date.now() + configuration.startupTimeoutMs }),
      configuration,
    );
    const allowed = new Set(configuration.allowCapabilities),
      capabilities = this.manifest.capabilities;
    const enabled = (name: keyof typeof capabilities): boolean =>
      allowed.has(name as (typeof configuration.allowCapabilities)[number]) && !!capabilities[name];
    this.descriptor = {
      ...this.manifest.descriptor,
      installation: {
        kind: 'process',
        protocolVersion: 1,
        identity: watchPluginIdentity(configuration),
        executable: configuration.command[0]!,
        version: configuration.version,
        envAllow: [...configuration.envAllow],
        capabilities: ['poll', ...Object.keys(capabilities).filter((name) => enabled(name as keyof typeof capabilities))],
      },
    };
    this.bindings = this.manifest.bindings;
    this.referenceSchema = pluginSchema(this.manifest.schemas.reference, 'Plugin reference');
    this.stateSchema = pluginSchema(this.manifest.schemas.state, 'Plugin state');
    this.cursorSchema = pluginSchema(this.manifest.schemas.cursor, 'Plugin cursor');
    const options = pluginSchema(this.manifest.schemas.options, 'Plugin options');
    this.optionsSchema = {
      json: options.json,
      parse(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return options.parse(value);
        return options.parse(pluginDto({ ...defaults, ...value }));
      },
    };
    if (enabled('acknowledgements') && capabilities.acknowledgements) this.acknowledgements = {
      patterns: capabilities.acknowledgements.patterns,
      exists: (key, culling) => pluginSchema<boolean | null>({ type: ['boolean', 'null'] }, 'Plugin item existence')
        .parse(this.call('watch.acknowledgement.exists', { key, culling })) ?? undefined,
      retain: (acknowledgement, standing) => pluginSchema<boolean>({ type: 'boolean' }, 'Plugin retained acknowledgement')
        .parse(this.call('watch.acknowledgement.retain', { acknowledgement, standing })),
    };
    if (enabled('triggers')) this.triggers = {
      parse: (subject, condition) => pluginSchema<ReturnType<WatchTriggerPolicy['parse']> | null>(
        { anyOf: [{ type: 'null' }, watchTriggerReferenceSchema] }, 'Plugin todo reference',
      ).parse(this.call('watch.trigger.parse', { subject, condition })) ?? undefined,
      read: (reference, since) => pluginSchema<ReturnType<WatchTriggerPolicy['read']>>(
        watchTriggerReadingSchema, 'Plugin todo condition',
      ).parse(this.call('watch.trigger.read', { reference, since })),
      prepare: (reference) => { this.call('watch.trigger.prepare', { reference }); },
      needsWatch: (reference) => pluginSchema<boolean>({ type: 'boolean' }, 'Plugin todo watch').parse(this.call('watch.trigger.needsWatch', { reference })),
      watchNote: (reference) => pluginSchema<string>(stringSchema, 'Plugin todo instructions').parse(this.call('watch.trigger.note', { reference })),
    };
    if (enabled('commands') && capabilities.commands) this.commands = {
      bindings: capabilities.commands.bindings,
      run: (request) => pluginSchema<string>(stringSchema, 'Plugin command output').parse(this.call('watch.command', { request })),
    };
    if (enabled('registration')) this.registration = {
      prepare: (request) => pluginSchema<ReturnType<WatchRegistrationPolicy['prepare']> | null>(
        watchRegistrationPlanSchema, 'Plugin registration',
      ).parse(this.call('watch.registration.prepare', { request })) ?? undefined,
      registered: (request, snapshot) => { this.call('watch.registration.registered', { request, snapshot }, snapshot); },
      sync: (now, phase) => { this.call('watch.registration.sync', { now, phase }); },
    };
    if (enabled('subscribe')) this.subscriber = { subscribe: (context) => this.subscribe(context) };
    if (enabled('batch'))
      this.batchObserver = {
        group: (context) =>
          pluginSchema<string>(stringSchema, 'Plugin batch group').parse(
            this.call('watch.batch.group', this.body(context), context.snapshot),
          ),
        pollBatch: (contexts) => {
          if (!contexts.length) return {};
          const result = this.call('watch.batch.poll', { contexts: contexts.map((context) => this.body(context)) }, contexts[0]!.snapshot);
          if (!result || typeof result !== 'object' || Array.isArray(result))
            throw new WatchPluginError('Plugin batch result must be keyed by watch');
          return Object.fromEntries(
            contexts.map((context) => {
              const value = result[context.snapshot.key];
              if (!value) throw new WatchPluginError(`Plugin batch omitted ${context.snapshot.key}`);
              return [
                context.snapshot.key,
                typeof value === 'object' && value && 'events' in value ? this.batch(value) : validateWatchFailure(value),
              ];
            }),
          );
        },
      };
    if (enabled('actions') && capabilities.actions) {
      const argumentsSchema = pluginSchema(capabilities.actions.arguments, 'Plugin action arguments'),
        resultSchema = pluginSchema(capabilities.actions.result, 'Plugin action result');
      this.effectHandler = {
        execution: 'sync',
        execute: (request) => {
          pluginSchema(watchActionRequestSchema, 'Plugin recorded action authority').parse(pluginDto(request));
          this.referenceSchema.parse(request.reference);
          argumentsSchema.parse(request.arguments);
          const value = this.call(
            'watch.actions.execute',
            { request },
            { key: this.key(request.reference), generation: request.generation ?? request.id },
          );
          pluginSchema(watchEffectResultSchema, 'Plugin effect result').parse(value);
          resultSchema.parse(value);
          return value as unknown as WatchEffectResult;
        },
      };
    }
    if (enabled('automation'))
      this.automation = {
        propose: (context) =>
          pluginSchema<WatchActionProposal[]>(
            { type: 'array', maxItems: 1000, items: actionProposalSchema },
            'Plugin action proposals',
          ).parse(this.call('watch.automation', this.body(context), context.snapshot)),
      };
    if (enabled('dispatch'))
      this.dispatchPolicy = {
        plan: (context) =>
          pluginSchema<ReturnType<NonNullable<typeof this.dispatchPolicy>['plan']>>(dispatchPlanSchema, 'Plugin dispatch plan').parse(
            this.call('watch.dispatch.plan', { ...this.body(context), events: context.events, repo: context.repo }, context.snapshot),
          ),
        prepareBrief: (context, filled) =>
          pluginSchema<string>(stringSchema, 'Plugin worker brief').parse(
            this.call(
              'watch.dispatch.brief',
              { ...this.body(context), events: context.events, repo: context.repo, filled },
              context.snapshot,
            ),
          ),
        delivered: (context, plan, workId) => {
          this.call(
            'watch.dispatch.delivered',
            { ...this.body(context), events: context.events, repo: context.repo, plan, workId },
            context.snapshot,
          );
        },
      };
    if (enabled('derived'))
      this.derived = {
        views: (now) => {
          const value = this.call('watch.derived', { now });
          const views = pluginSchema<ReturnType<WatchDerivation['views']>>(
            {
              type: 'array',
              maxItems: 10000,
              items: {
                type: 'object',
                required: ['key', 'input', 'options', 'owner', 'revision', 'since', 'presentation'],
                additionalProperties: false,
                properties: {
                  key: stringSchema,
                  input: stringSchema,
                  options: {},
                  revision: stringSchema,
                  since: { type: 'string', format: 'date-time' },
                  presentation: {},
                  owner: {
                    type: 'object',
                    required: ['kind', 'grounds'],
                    properties: {
                      kind: { enum: ['helm', 'dispatch', 'trap'] },
                      grounds: stringSchema,
                      chainId: stringSchema,
                      trapId: stringSchema,
                    },
                  },
                },
              },
            },
            'Plugin derived views',
          ).parse(value);
          for (const view of views) validateWatchPresentation(view.presentation);
          return views;
        },
      };
    if (enabled('notices') && capabilities.notices)
      this.noticePolicy = {
        ...capabilities.notices,
        current: (notice) =>
          pluginSchema<boolean>({ type: 'boolean' }, 'Plugin notice state').parse(this.call('watch.notice.current', { notice })),
        relatedDispatches: (notice) =>
          pluginSchema<string[]>({ type: 'array', items: stringSchema }, 'Plugin notice ownership').parse(
            this.call('watch.notice.dispatches', { notice }),
          ),
      };
  }

  private metadata(snapshot?: Pick<WatchSnapshot, 'key' | 'generation'>): Partial<WatchPluginContext> {
    return snapshot ? { watchKey: snapshot.key, generation: snapshot.generation } : {};
  }
  private call(method: string, body: unknown, snapshot?: Pick<WatchSnapshot, 'key' | 'generation'>): WatchValue {
    return this.transport.callSync(method, pluginDto(body), this.metadata(snapshot));
  }
  private body(context: PluginContext): { snapshot: WatchSnapshot; now: string; everySecs?: number } {
    return { snapshot: context.snapshot, now: context.now, ...(context.everySecs === undefined ? {} : { everySecs: context.everySecs }) };
  }
  private batch(value: unknown): WatchObservationBatch<WatchValue> {
    const batch = pluginSchema<WatchObservationBatch<WatchValue>>(watchBatchSchema, 'Plugin observation').parse(value);
    this.cursorSchema.parse(batch.cursor);
    return batch;
  }
  identify(input: string, options: WatchValue): WatchValue | undefined {
    const value = this.call('watch.identify', { input, options });
    return value === null ? undefined : this.referenceSchema.parse(value);
  }
  key(reference: WatchValue): string {
    return pluginSchema<string>({ type: 'string', minLength: 1 }, 'Plugin watch key').parse(this.call('watch.key', { reference }));
  }
  initialize(reference: WatchValue, options: WatchValue): { state: WatchValue; cursor: WatchValue } {
    const result = pluginSchema<{ state: WatchValue; cursor: WatchValue }>(
      { type: 'object', required: ['state', 'cursor'], additionalProperties: false, properties: { state: {}, cursor: {} } },
      'Plugin initialization',
    ).parse(this.call('watch.initialize', { reference, options }, { key: this.key(reference), generation: 'registration' }));
    return { state: this.stateSchema.parse(result.state), cursor: this.cursorSchema.parse(result.cursor) };
  }
  restore(snapshot: WatchSnapshot): WatchSnapshot {
    const value = pluginSchema<{ reference: WatchValue; state: WatchValue; cursor: WatchValue; options: WatchValue; stateVersion: number }>(
      {
        type: 'object',
        required: ['reference', 'state', 'cursor', 'options', 'stateVersion'],
        additionalProperties: false,
        properties: { reference: {}, state: {}, cursor: {}, options: {}, stateVersion: { const: this.descriptor.stateVersion } },
      },
      'Plugin restored state',
    ).parse(this.call('watch.restore', { snapshot }, snapshot));
    const reference = this.referenceSchema.parse(value.reference);
    if (this.key(reference) !== snapshot.key) throw new WatchPluginError('Plugin state migration changed the durable watch key');
    if (snapshot.type.stateVersion === value.stateVersion && JSON.stringify(value.cursor) !== JSON.stringify(snapshot.cursor))
      throw new WatchPluginError('Plugin restore changed a cursor without a state migration');
    return {
      ...snapshot,
      type: this.descriptor,
      reference,
      state: this.stateSchema.parse(value.state),
      cursor: this.cursorSchema.parse(value.cursor),
      options: this.optionsSchema.parse(value.options),
    };
  }
  poll(context: PluginContext): WatchObservationBatch<WatchValue> {
    return this.batch(this.call('watch.poll', this.body(context), context.snapshot));
  }
  reduce(snapshot: WatchSnapshot, batch: WatchObservationBatch<WatchValue>) {
    const plan = pluginSchema<{ state: WatchValue; cursor: WatchValue; done: boolean }>(
      {
        type: 'object',
        required: ['state', 'cursor', 'done'],
        additionalProperties: false,
        properties: { state: {}, cursor: {}, done: { type: 'boolean' } },
      },
      'Plugin reduction',
    ).parse(this.call('watch.reduce', { snapshot, batch }, snapshot));
    return { state: this.stateSchema.parse(plan.state), cursor: this.cursorSchema.parse(plan.cursor), done: plan.done };
  }
  present(snapshot: WatchSnapshot): WatchPresentation {
    return validateWatchPresentation(this.call('watch.present', { snapshot }, snapshot));
  }
  failure(error: unknown): WatchFailure {
    if (error instanceof WatchPluginError) return validateWatchFailure(error.failure);
    try {
      return validateWatchFailure(this.call('watch.failure', { message: error instanceof Error ? error.message : String(error) }));
    } catch (failure) {
      return failure instanceof WatchPluginError ? failure.failure : new WatchPluginError(String(failure)).failure;
    }
  }
  close(context: PluginContext, reason: WatchCloseReason): void {
    this.call('watch.close', { ...this.body(context), reason }, context.snapshot);
  }
  private async *subscribe(context: PluginContext): AsyncIterable<WatchObservationBatch<WatchValue>> {
    const metadata: WatchPluginContext = {
      protocolVersion: 1,
      watchKey: context.snapshot.key,
      generation: context.snapshot.generation,
      deadline: Date.now() + this.configuration.requestTimeoutMs,
    };
    for await (const value of this.transport.subscribe(pluginDto(this.body(context)), metadata, context.signal)) yield this.batch(value);
  }
}

/** An unavailable installation remains a visible, holdable type instead of disappearing from its owner. */
export class UnavailableWatchType extends BaseWatchType<WatchValue, WatchValue, WatchValue, WatchValue> {
  readonly referenceSchema = jsonSchema;
  readonly stateSchema = jsonSchema;
  readonly optionsSchema = jsonSchema;
  readonly cursorSchema = jsonSchema;
  readonly bindings = [{ event: 'explicit' as const, field: 'key' }];
  constructor(
    readonly descriptor: WatchTypeDescriptor,
    readonly reason: WatchFailure,
  ) {
    super();
  }
  identify(input: string): WatchValue | undefined {
    return input.startsWith(`${this.descriptor.id}:`) ? { input } : undefined;
  }
  key(reference: WatchValue): string {
    return String((reference as { input: string }).input);
  }
  initialize() {
    return { state: {}, cursor: '0' };
  }
  restore(snapshot: WatchSnapshot): WatchSnapshot {
    return snapshot;
  }
  poll(): never {
    throw new WatchPluginError(this.reason.message, this.reason);
  }
  reduce(snapshot: WatchSnapshot) {
    return { state: snapshot.state, cursor: snapshot.cursor, done: false };
  }
  present(snapshot: WatchSnapshot): WatchPresentation {
    if (snapshot.presentation.title) return snapshot.presentation;
    return {
      title: this.descriptor.id,
      label: 'Unavailable watch',
      summary: this.reason.message,
      tone: 'risk',
      worker: { steps: [this.reason.remedy ?? this.reason.message] },
      helm: { steps: [this.reason.remedy ?? this.reason.message] },
      rows: [{ label: 'Adapter', value: `${this.descriptor.id} ${this.descriptor.version}` }],
      links: [],
      actions: [],
      attention: [],
    };
  }
  failure(): WatchFailure {
    return { ...this.reason, hold: true };
  }
  close(): void {
    /* No provider resources were acquired for an unavailable installation. */
  }
}

/** Healthy adapters share one validated installation; failures keep their bounded transport restart state. */
export function createProcessWatchType(
  configuration: WatchPluginConfiguration,
  defaults: Record<string, unknown> = {},
  prior?: WatchTypeDescriptor,
): ProcessWatchType | UnavailableWatchType {
  const key = connectionKey(configuration) + ':' + JSON.stringify(defaults);
  const priorAdapter = adapters.get(key);
  if (priorAdapter) return priorAdapter;
  try {
    const adapter = new ProcessWatchType(configuration, defaults);
    adapters.set(key, adapter);
    return adapter;
  } catch (error) {
    const failure = error instanceof WatchPluginError ? error.failure : new WatchPluginError(String(error)).failure;
    return new UnavailableWatchType(
      {
        id: configuration.id,
        apiVersion: 1,
        stateVersion: prior?.stateVersion ?? 1,
        version: configuration.version,
        ...(prior?.attentionKinds ? { attentionKinds: prior.attentionKinds } : {}),
        installation: {
          kind: 'process',
          protocolVersion: 1,
          identity: watchPluginIdentity(configuration),
          executable: configuration.command[0]!,
          version: configuration.version,
          envAllow: [...configuration.envAllow],
          capabilities: [],
        },
      },
      { ...failure, hold: true },
    );
  }
}
