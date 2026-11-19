import * as readline from 'node:readline';
import type { BaseWatchType } from './base.js';
import type { WatchAcknowledgement, WatchTriggerReference, WatchCommandRequest, WatchRegistrationRequest, WatchCloseReason, WatchContext, WatchSnapshot, WatchValue } from './model.js';
import {
  pluginDto,
  validateWatchFailure,
  validateWatchPresentation,
  watchEffectResultSchema,
  watchActionRequestSchema,
  pluginSchema,
} from './plugin-model.js';
import type { PluginJsonSchema, WatchPluginManifest, WatchPluginRequest } from './plugin-model.js';

/** Optional action schemas supplement the shared recorded-authorization envelope. */
export interface WatchPluginServerOptions {
  actionSchemas?: { arguments: PluginJsonSchema; result: PluginJsonSchema };
  maxMessageBytes?: number;
}

/** The same adapter class publishes its schemas, instructions and composed capabilities in either host. */
export function watchPluginManifest<Reference, State, Cursor, Options>(
  adapter: BaseWatchType<Reference, State, Cursor, Options>,
  options: WatchPluginServerOptions = {},
): WatchPluginManifest {
  const capabilities: WatchPluginManifest['capabilities'] = {};
  if (adapter.acknowledgements) capabilities.acknowledgements = { patterns: [...adapter.acknowledgements.patterns] };
  if (adapter.triggers) capabilities.triggers = true;
  if (adapter.commands) capabilities.commands = { bindings: [...adapter.commands.bindings] };
  if (adapter.registration) capabilities.registration = true;
  if (adapter.batchObserver) capabilities.batch = true;
  if (adapter.subscriber) capabilities.subscribe = true;
  if (adapter.effectHandler) {
    if (!options.actionSchemas) throw new Error('Watch plugin actions require argument and result schemas');
    capabilities.actions = { authorityRequired: true, ...options.actionSchemas };
  }
  if (adapter.automation) capabilities.automation = true;
  if (adapter.dispatchPolicy) capabilities.dispatch = true;
  if (adapter.derived) capabilities.derived = true;
  if (adapter.noticePolicy)
    capabilities.notices = {
      kinds: [...adapter.noticePolicy.kinds],
      ...(adapter.noticePolicy.quietKinds ? { quietKinds: [...adapter.noticePolicy.quietKinds] } : {}),
    };
  const { installation: _installation, ...descriptor } = adapter.descriptor;
  return {
    protocolVersion: 1,
    presentationVersion: 1,
    descriptor,
    schemas: {
      reference: pluginDto(adapter.referenceSchema.json) as PluginJsonSchema,
      options: pluginDto(adapter.optionsSchema.json) as PluginJsonSchema,
      state: pluginDto(adapter.stateSchema.json) as PluginJsonSchema,
      cursor: pluginDto(adapter.cursorSchema.json) as PluginJsonSchema,
    },
    bindings: pluginDto(adapter.bindings) as unknown as WatchPluginManifest['bindings'],
    capabilities,
  };
}

/** The stdio runner does no scheduling and grants no authority; it delegates the existing adapter contract. */
export async function serveWatchPlugin<Reference, State, Cursor, Options>(
  adapter: BaseWatchType<Reference, State, Cursor, Options>,
  options: WatchPluginServerOptions = {},
): Promise<void> {
  const manifest = watchPluginManifest(adapter, options),
    limit = options.maxMessageBytes ?? 1024 * 1024;
  const controls = new Map<string, AbortController>(),
    tasks = new Set<Promise<void>>();
  let buffered = '',
    ended = false;
  const write = (message: unknown): void => {
    const text = JSON.stringify(pluginDto(message));
    if (Buffer.byteLength(text) > limit) throw new Error('Watch plugin output exceeded its message limit');
    process.stdout.write(text + '\n');
  };
  const dispatch = async (request: WatchPluginRequest): Promise<WatchValue> => {
    const body = request.params.body as Record<string, unknown>,
      controller = controls.get(request.id)!;
    const snapshot = body.snapshot as WatchSnapshot<Reference, State, Cursor, Options>;
    const context = (): WatchContext<Reference, State, Cursor, Options> => {
      if (!snapshot || snapshot.key !== request.params.watchKey || snapshot.generation !== request.params.generation)
        throw new Error('Watch plugin request generation does not match its snapshot');
      return {
        snapshot,
        now: String(body.now),
        ...(body.everySecs === undefined ? {} : { everySecs: Number(body.everySecs) }),
        signal: controller.signal,
      };
    };
    switch (request.method) {
      case 'watch.handshake':
        return pluginDto(manifest);
      case 'watch.acknowledgement.exists':
        if (!adapter.acknowledgements) throw new Error('Watch plugin acknowledgement capability is unavailable');
        return adapter.acknowledgements.exists(String(body.key), body.culling as string[]) ?? null;
      case 'watch.acknowledgement.retain':
        if (!adapter.acknowledgements) throw new Error('Watch plugin acknowledgement capability is unavailable');
        return adapter.acknowledgements.retain(body.acknowledgement as unknown as WatchAcknowledgement, body.standing as WatchValue | undefined);
      case 'watch.trigger.parse':
        if (!adapter.triggers) throw new Error('Watch plugin trigger capability is unavailable');
        return pluginDto(adapter.triggers.parse(String(body.subject), body.condition === undefined ? undefined : String(body.condition)) ?? null);
      case 'watch.trigger.read':
        if (!adapter.triggers) throw new Error('Watch plugin trigger capability is unavailable');
        return pluginDto(adapter.triggers.read(body.reference as unknown as WatchTriggerReference, String(body.since)));
      case 'watch.trigger.prepare':
        if (!adapter.triggers) throw new Error('Watch plugin trigger capability is unavailable');
        adapter.triggers.prepare?.(body.reference as unknown as WatchTriggerReference);
        return null;
      case 'watch.trigger.needsWatch':
        if (!adapter.triggers) throw new Error('Watch plugin trigger capability is unavailable');
        return adapter.triggers.needsWatch?.(body.reference as unknown as WatchTriggerReference) ?? true;
      case 'watch.trigger.note':
        if (!adapter.triggers) throw new Error('Watch plugin trigger capability is unavailable');
        return adapter.triggers.watchNote?.(body.reference as unknown as WatchTriggerReference) ?? '';
      case 'watch.command': {
        if (!adapter.commands) throw new Error('Watch plugin command capability is unavailable');
        const command = body.request as unknown as WatchCommandRequest;
        if (!adapter.commands.bindings.some(binding => binding.name === command.name &&
          (!binding.pattern || new RegExp(binding.pattern).test(command.args[0] ?? '')))) throw new Error('Unknown watch adapter command');
        return pluginDto(await adapter.commands.run(command));
      }
      case 'watch.registration.prepare':
        if (!adapter.registration) throw new Error('Watch plugin registration capability is unavailable');
        return pluginDto(adapter.registration.prepare(body.request as unknown as WatchRegistrationRequest) ?? null);
      case 'watch.registration.registered':
        if (!adapter.registration) throw new Error('Watch plugin registration capability is unavailable');
        adapter.registration.registered?.(body.request as unknown as WatchRegistrationRequest, body.snapshot as unknown as WatchSnapshot);
        return null;
      case 'watch.registration.sync':
        if (!adapter.registration) throw new Error('Watch plugin registration capability is unavailable');
        adapter.registration.sync?.(String(body.now), body.phase as 'before-observe' | 'after-observe' | 'report');
        return null;
      case 'watch.identify':
        return pluginDto(adapter.identify(String(body.input), adapter.optionsSchema.parse(body.options)) ?? null);
      case 'watch.key':
        return pluginDto(adapter.key(adapter.referenceSchema.parse(body.reference)));
      case 'watch.initialize':
        return pluginDto(adapter.initialize(adapter.referenceSchema.parse(body.reference), adapter.optionsSchema.parse(body.options)));
      case 'watch.restore': {
        if (!snapshot || snapshot.key !== request.params.watchKey || snapshot.generation !== request.params.generation)
          throw new Error('Watch plugin restore generation does not match');
        const restored = adapter.restore(snapshot as unknown as WatchSnapshot);
        return pluginDto({
          reference: restored.reference,
          state: restored.state,
          cursor: restored.cursor,
          options: restored.options,
          stateVersion: restored.type.stateVersion,
        });
      }
      case 'watch.poll':
        return pluginDto(await adapter.poll(context()));
      case 'watch.reduce':
        return pluginDto(
          adapter.reduce(adapter.restore(snapshot as unknown as WatchSnapshot), body.batch as Parameters<typeof adapter.reduce>[1]),
        );
      case 'watch.present':
        return pluginDto(validateWatchPresentation(adapter.present(adapter.restore(snapshot as unknown as WatchSnapshot))));
      case 'watch.failure':
        return pluginDto(validateWatchFailure(adapter.failure(new Error(String(body.message)))));
      case 'watch.close':
        await adapter.close(context(), body.reason as WatchCloseReason);
        return null;
      case 'watch.batch.group': {
        if (!adapter.batchObserver) throw new Error('Watch plugin batch capability is unavailable');
        return pluginDto(adapter.batchObserver.group(context()));
      }
      case 'watch.batch.poll': {
        if (!adapter.batchObserver) throw new Error('Watch plugin batch capability is unavailable');
        return pluginDto(
          await adapter.batchObserver.pollBatch(
            (body.contexts as WatchContext<Reference, State, Cursor, Options>[]).map((entry) => ({ ...entry, signal: controller.signal })),
          ),
        );
      }
      case 'watch.actions.execute': {
        if (!adapter.effectHandler || !manifest.capabilities.actions) throw new Error('Watch plugin action capability is unavailable');
        const action = pluginSchema<Parameters<typeof adapter.effectHandler.execute>[0]>(
          watchActionRequestSchema,
          'Watch action authority',
        ).parse(body.request);
        if (action.generation !== request.params.generation) throw new Error('Watch action generation does not match its request');
        if (action.generation !== undefined && action.generation !== request.params.generation)
          throw new Error('Watch action generation does not match its authority envelope');
        pluginSchema(manifest.capabilities.actions.arguments, 'Watch action arguments').parse(action.arguments);
        const reference = adapter.referenceSchema.parse(action.reference);
        if (adapter.key(reference) !== request.params.watchKey || (action.generation ?? action.id) !== request.params.generation)
          throw new Error('Watch action generation or reference does not match its envelope');
        const result = await adapter.effectHandler.execute(action);
        pluginSchema(watchEffectResultSchema, 'Watch effect result').parse(result);
        pluginSchema(manifest.capabilities.actions.result, 'Watch plugin action result').parse(result);
        return pluginDto(result);
      }
      case 'watch.automation': {
        if (!adapter.automation) throw new Error('Watch plugin automation capability is unavailable');
        return pluginDto(adapter.automation.propose(context()));
      }
      case 'watch.dispatch.plan': {
        if (!adapter.dispatchPolicy) throw new Error('Watch plugin dispatch capability is unavailable');
        return pluginDto(
          adapter.dispatchPolicy.plan({
            ...context(),
            events: body.events as WatchSnapshot<Reference, State, Cursor, Options>['events'],
            ...(body.repo ? { repo: String(body.repo) } : {}),
          }),
        );
      }
      case 'watch.dispatch.brief': {
        if (!adapter.dispatchPolicy) throw new Error('Watch plugin dispatch capability is unavailable');
        return pluginDto(
          adapter.dispatchPolicy.prepareBrief?.(
            {
              ...context(),
              events: body.events as WatchSnapshot<Reference, State, Cursor, Options>['events'],
              ...(body.repo ? { repo: String(body.repo) } : {}),
            },
            String(body.filled),
          ) ?? String(body.filled),
        );
      }
      case 'watch.dispatch.delivered': {
        if (!adapter.dispatchPolicy) throw new Error('Watch plugin dispatch capability is unavailable');
        adapter.dispatchPolicy.delivered?.(
          {
            ...context(),
            events: body.events as WatchSnapshot<Reference, State, Cursor, Options>['events'],
            ...(body.repo ? { repo: String(body.repo) } : {}),
          },
          body.plan as Parameters<NonNullable<typeof adapter.dispatchPolicy.delivered>>[1],
          String(body.workId),
        );
        return null;
      }
      case 'watch.derived': {
        if (!adapter.derived) throw new Error('Watch plugin derivation capability is unavailable');
        return pluginDto(adapter.derived.views(String(body.now)));
      }
      case 'watch.notice.current': {
        if (!adapter.noticePolicy) throw new Error('Watch plugin notice capability is unavailable');
        return pluginDto(adapter.noticePolicy.current(body.notice as Parameters<typeof adapter.noticePolicy.current>[0]));
      }
      case 'watch.notice.dispatches': {
        if (!adapter.noticePolicy) throw new Error('Watch plugin notice capability is unavailable');
        return pluginDto(adapter.noticePolicy.relatedDispatches?.(body.notice as Parameters<typeof adapter.noticePolicy.current>[0]) ?? []);
      }
      case 'watch.subscribe': {
        if (!adapter.subscriber) throw new Error('Watch plugin subscription capability is unavailable');
        try {
          for await (const batch of adapter.subscriber.subscribe(context())) {
            if (controller.signal.aborted) break;
            write({
              jsonrpc: '2.0',
              method: 'watch.observation',
              params: { ...request.params, body: undefined, requestId: request.id, batch },
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
        return { closed: true };
      }
      default:
        throw new Error(`Unknown watch plugin method: ${request.method}`);
    }
  };
  const handle = async (line: string): Promise<void> => {
    let request: WatchPluginRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = JSON.parse(line) as WatchPluginRequest | { jsonrpc?: string; method?: string; params?: { requestId?: string } };
      if (value.jsonrpc === '2.0' && value.method === 'watch.cancel') {
        const target = (value.params as { requestId?: string })?.requestId;
        if (target) controls.get(target)?.abort();
        return;
      }
      request = value as WatchPluginRequest;
      if (
        request.jsonrpc !== '2.0' ||
        typeof request.id !== 'string' ||
        !request.id ||
        typeof request.method !== 'string' ||
        request.params?.protocolVersion !== 1 ||
        typeof request.params.watchKey !== 'string' ||
        typeof request.params.generation !== 'string' ||
        !Number.isSafeInteger(request.params.deadline) ||
        request.params.deadline <= Date.now() ||
        request.params.deadline > Date.now() + 120_000
      )
        throw new Error('Invalid or expired watch plugin request');
      pluginDto(request.params.body);
      if (controls.has(request.id)) throw new Error('Duplicate watch plugin request ID');
      const controller = new AbortController();
      controls.set(request.id, controller);
      timer = setTimeout(() => controller.abort(), Math.max(1, request.params.deadline - Date.now()));
      const result = await dispatch(request);
      write({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      let failure;
      try {
        failure = validateWatchFailure(adapter.failure(error));
      } catch {
        failure = { kind: 'plugin', message: error instanceof Error ? error.message : String(error), hold: true };
      }
      write({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: failure.message, data: { failure } } });
    } finally {
      if (timer) clearTimeout(timer);
      if (request) controls.delete(request.id);
    }
  };
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (ended) return;
    if (Buffer.byteLength(line) > limit || tasks.size >= 1000) {
      process.stderr.write('Watch plugin input limit exceeded\n');
      process.exitCode = 1;
      ended = true;
      input.close();
      controls.forEach((controller) => controller.abort());
      return;
    }
    const task = handle(line);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  // Limit a line before readline can accumulate unbounded data without a newline.
  process.stdin.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const last = buffered.lastIndexOf('\n');
    if (last >= 0) buffered = buffered.slice(last + 1);
    if (Buffer.byteLength(buffered) > limit) {
      process.stderr.write('Watch plugin input buffer exceeded\n');
      process.exitCode = 1;
      input.close();
      controls.forEach((controller) => controller.abort());
    }
  });
  await new Promise<void>((resolve) => input.once('close', resolve));
  controls.forEach((controller) => controller.abort());
  await Promise.allSettled(tasks);
}
