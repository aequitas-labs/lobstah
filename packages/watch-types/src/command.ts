import { spawnSync } from 'node:child_process';
import { BaseWatchType } from './base.js';
import type { WatchContext, WatchObservationBatch, WatchPresentation, WatchSchema, WatchSnapshot, WatchValue, WatchTypeDescriptor } from './model.js';
import { watchJson } from './registry.js';

export interface CommandWatchReference {
  key: string;
}
export interface CommandWatchOptions {
  check: string;
  cursor?: string;
  brief?: string;
  cwd?: string;
  environment?: Record<string, string>;
}
export type CommandWatchState = Record<string, never>;

/** A command failure retains its exit status for the compatibility report. */
export class WatchCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

/** Validate a nonempty string without coercing malformed provider output. */
export const watchStringSchema: WatchSchema<string> = {
  json: { type: 'string' },
  parse(value) {
    if (typeof value !== 'string') throw new Error('Expected a watch string');
    return value;
  },
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a watch object');
  return value as Record<string, unknown>;
}

/** The existing check-command protocol is an adapter, including custom briefs. */
export class CommandWatchType extends BaseWatchType<CommandWatchReference, CommandWatchState, string, CommandWatchOptions> {
  readonly descriptor: WatchTypeDescriptor = { id: 'command', keyPrefix: '', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly bindings = [{ event: 'explicit' as const, field: 'key' }];
  readonly referenceSchema: WatchSchema<CommandWatchReference> = {
    json: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } },
    parse(value) {
      const key = watchStringSchema.parse(object(value).key);
      if (!key.trim()) throw new Error('A watch key is required');
      return { key };
    },
  };
  readonly stateSchema: WatchSchema<CommandWatchState> = {
    json: { type: 'object', additionalProperties: false },
    parse(value) {
      if (Object.keys(object(value)).length) throw new Error('Command watch state must be empty');
      return {};
    },
  };
  readonly cursorSchema = watchStringSchema;
  readonly optionsSchema: WatchSchema<CommandWatchOptions> = {
    json: {
      type: 'object',
      required: ['check'],
      properties: {
        check: { type: 'string' },
        cursor: { type: 'string' },
        brief: { type: 'string' },
        cwd: { type: 'string' },
        environment: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    parse(value) {
      const raw = object(value),
        check = watchStringSchema.parse(raw.check);
      if (!check.trim()) throw new Error('A watch check command is required');
      const options: CommandWatchOptions = { check };
      for (const key of ['cursor', 'brief', 'cwd'] as const) if (raw[key] !== undefined) options[key] = watchStringSchema.parse(raw[key]);
      if (raw.environment !== undefined)
        options.environment = Object.fromEntries(
          Object.entries(object(raw.environment)).map(([key, entry]) => [key, watchStringSchema.parse(entry)]),
        );
      return options;
    },
  };

  identify(input: string): CommandWatchReference {
    return this.referenceSchema.parse({ key: input });
  }
  key(reference: CommandWatchReference): string {
    return reference.key;
  }
  initialize(_reference: CommandWatchReference, options: CommandWatchOptions): { state: CommandWatchState; cursor: string } {
    return { state: {}, cursor: options.cursor ?? '0' };
  }

  restore(snapshot: WatchSnapshot): WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions> {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Command watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }

  /** Commands keep their historical shell syntax; new adapters use argv directly. */
  poll({
    snapshot,
    now,
  }: WatchContext<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>): WatchObservationBatch<string> {
    const { options, cursor } = snapshot;
    const result = spawnSync(options.check.replaceAll('{cursor}', cursor), {
      shell: true,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: options.cwd,
      env: { ...process.env, ...options.environment },
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new WatchCommandError(
        result.error?.message || result.stderr.trim() || result.stdout.trim() || `Watch check exited ${result.status}`,
        result.status ?? undefined,
      );
    return parseCommandWatchBatch(result.stdout, cursor, now);
  }

  reduce(
    _snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>,
    batch: WatchObservationBatch<string>,
  ) {
    return { state: {}, cursor: batch.cursor, done: batch.done === true };
  }

  present(snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>): WatchPresentation {
    return {
      title: snapshot.key,
      summary: snapshot.events.at(-1)?.summary ?? '',
      label: 'Watch',
      tone: snapshot.failure ? 'risk' : 'neutral',
      worker: { steps: [snapshot.options.brief ?? 'Read the watched events, act on them, and report the outcome.'] },
      helm: { steps: ['Read the pending watch events and their owning chain before dispatching more work.'] },
      rows: [{ label: 'Cursor', value: snapshot.cursor }],
      links: [],
      actions: [],
      attention: [],
    };
  }

  failure(error: unknown) {
    return {
      kind: 'command',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof WatchCommandError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
    };
  }
  close(): void {
    /* The check command has no held source resources. */
  }
}

/** Normalize command JSON once for both compatibility callers and typed watches. */
export function parseCommandWatchBatch(output: string, cursor: string, now: string): WatchObservationBatch<string> {
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(output));
  } catch {
    throw new Error(`unparseable check output: ${output.slice(0, 200).trim()}`);
  }
  if (raw.events !== undefined && !Array.isArray(raw.events)) throw new Error('Watch events must be an array');
  const events = ((raw.events ?? []) as unknown[]).map((value) => {
    const event = object(value),
      sequence = event.seq ?? cursor;
    if (typeof sequence !== 'string' && (typeof sequence !== 'number' || !Number.isFinite(sequence)))
      throw new Error('Watch event sequence must be a string or finite number');
    return {
      id: String(sequence),
      kind: typeof event.kind === 'string' ? event.kind : 'event',
      summary: event.summary === undefined ? '' : String(event.summary),
      at: now,
      data: watchJson(event),
    };
  });
  const next = raw.cursor ?? cursor;
  if (typeof next !== 'string' && (typeof next !== 'number' || !Number.isFinite(next)))
    throw new Error('Watch cursor must be a string or finite number');
  return {
    cursor: String(next),
    events,
    ...(raw.done === true ? { done: true } : {}),
    ...(typeof raw.error === 'string' && raw.error ? { failure: { kind: 'command', message: raw.error } } : {}),
  };
}
