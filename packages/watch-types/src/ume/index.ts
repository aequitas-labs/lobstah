import { BaseWatchType } from '../base.js';
import { CommandWatchType, watchStringSchema } from '../command.js';
import type { CommandWatchOptions } from '../command.js';
import type { WatchContext, WatchFailure, WatchObservationBatch, WatchSchema, WatchSnapshot, WatchSubscriber } from '../model.js';

export const UME_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Artifact identity stays stable when legacy project context is recovered. */
export interface UmeWatchReference {
  artifact: string;
  url: string;
}
/** Recovered context is a checkpoint, so ambient project changes cannot redirect a watch. */
export interface UmeWatchState {
  project: string | null;
  org: string | null;
}
export interface UmeWatchOptions extends Partial<CommandWatchOptions> {
  project?: string;
  org?: string;
}
export type UmeWatchSnapshot = WatchSnapshot<UmeWatchReference, UmeWatchState, string, UmeWatchOptions>;
export type UmeWatchContext = WatchContext<UmeWatchReference, UmeWatchState, string, UmeWatchOptions>;
export interface UmeWatchServices {
  observe(context: UmeWatchContext): WatchObservationBatch<string>;
  failure(error: unknown): WatchFailure;
  subscriber?: WatchSubscriber<UmeWatchReference, UmeWatchState, string, UmeWatchOptions>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ume watch data');
  return value as Record<string, unknown>;
}

/** Ume owns feedback normalization, project context and the read instructions for every consumer. */
export class UmeWatchType extends BaseWatchType<UmeWatchReference, UmeWatchState, string, UmeWatchOptions> {
  readonly descriptor = { id: 'ume', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly bindings = [
    { event: 'report' as const, field: 'link' },
    { event: 'turn-wait' as const, field: 'read' },
    { event: 'legacy-command' as const, field: 'check', pattern: '\\bwatch\\s+check-ume\\b', importsType: 'command' },
  ];
  private readonly command = new CommandWatchType();
  readonly cursorSchema: WatchSchema<string> = {
    json: { type: 'string', pattern: '^[0-9]+$' },
    parse(value) {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('Ume cursor must be a nonnegative safe integer');
      return value;
    },
  };
  readonly referenceSchema: WatchSchema<UmeWatchReference> = {
    json: { type: 'object', required: ['artifact', 'url'], properties: { artifact: { type: 'string' }, url: { type: 'string' } } },
    parse(value) {
      const raw = object(value),
        artifact = watchStringSchema.parse(raw.artifact);
      if (!UME_ARTIFACT_ID.test(artifact) || raw.url !== `https://app.ume.so/a/${artifact}`)
        throw new Error('Invalid ume artifact identity');
      return { artifact, url: raw.url as string };
    },
  };
  readonly stateSchema: WatchSchema<UmeWatchState> = {
    json: {
      type: 'object',
      required: ['project', 'org'],
      properties: { project: { type: ['string', 'null'] }, org: { type: ['string', 'null'] } },
    },
    parse(value) {
      const raw = object(value);
      if (!(raw.project === null || typeof raw.project === 'string') || !(raw.org === null || typeof raw.org === 'string'))
        throw new Error('Invalid ume project checkpoint');
      if (raw.project && !UME_ARTIFACT_ID.test(raw.project)) throw new Error('Invalid ume project identity');
      return { project: raw.project, org: raw.org } as UmeWatchState;
    },
  };
  readonly optionsSchema: WatchSchema<UmeWatchOptions> = {
    json: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        org: { type: 'string' },
        cwd: { type: 'string' },
        cursor: { type: 'string' },
        check: { type: 'string' },
        environment: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    parse: (value) => {
      const raw = object(value),
        legacy = raw.legacy ? object(raw.legacy) : {},
        context = legacy.context ? object(legacy.context) : {};
      const options: UmeWatchOptions = {};
      const command = raw.check
        ? this.command.optionsSchema.parse({ ...raw, cwd: raw.cwd ?? context.cwd, environment: raw.environment ?? context.env })
        : undefined;
      if (command) Object.assign(options, command);
      else {
        for (const key of ['cwd', 'brief'] as const) if (raw[key] !== undefined) options[key] = watchStringSchema.parse(raw[key]);
        if (raw.environment !== undefined)
          options.environment = Object.fromEntries(
            Object.entries(object(raw.environment)).map(([key, entry]) => [key, watchStringSchema.parse(entry)]),
          );
      }
      if (raw.cursor !== undefined) options.cursor = this.cursorSchema.parse(raw.cursor);
      const project = raw.project ?? options.environment?.UME_PROJECT,
        org = raw.org ?? context.org;
      if (project !== undefined) {
        options.project = watchStringSchema.parse(project);
        if (!UME_ARTIFACT_ID.test(options.project)) throw new Error('Invalid ume project identity');
      }
      if (org !== undefined) options.org = watchStringSchema.parse(org);
      return options;
    },
  };
  readonly subscriber: UmeWatchServices['subscriber'];
  constructor(private readonly services: UmeWatchServices) {
    super();
    this.subscriber = services.subscriber;
  }
  identify(input: string): UmeWatchReference | undefined {
    const artifact = input.replace(/^ume:/, '').replace(/^https:\/\/app\.ume\.so\/a\//, '');
    return UME_ARTIFACT_ID.test(artifact) ? { artifact, url: `https://app.ume.so/a/${artifact}` } : undefined;
  }
  key(reference: UmeWatchReference): string {
    return `ume:${reference.artifact}`;
  }
  initialize(_reference: UmeWatchReference, options: UmeWatchOptions) {
    return { state: { project: options.project ?? null, org: options.org ?? null }, cursor: options.cursor ?? '0' };
  }
  restore(snapshot: WatchSnapshot): UmeWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Ume watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(context: UmeWatchContext): WatchObservationBatch<string> {
    const { snapshot } = context;
    if (snapshot.options.check && !/\bwatch\s+check-ume\b/.test(snapshot.options.check)) {
      return this.command.poll({
        ...context,
        snapshot: {
          ...snapshot,
          reference: { key: snapshot.key },
          state: {},
          options: { ...snapshot.options, check: snapshot.options.check },
        },
      });
    }
    return this.services.observe(context);
  }
  reduce(snapshot: UmeWatchSnapshot, batch: WatchObservationBatch<string>) {
    const state = batch.payload === undefined ? snapshot.state : this.stateSchema.parse(batch.payload);
    return {
      state,
      cursor: String(Math.max(Number(snapshot.cursor), Number(this.cursorSchema.parse(batch.cursor)))),
      done: batch.done === true,
    };
  }
  present(snapshot: UmeWatchSnapshot) {
    const project = snapshot.state.project ?? snapshot.options.project;
    const read = {
      executable: 'ume',
      args: ['feedback', snapshot.reference.artifact],
      ...(snapshot.options.cwd ? { cwd: snapshot.options.cwd } : {}),
      environment: { UME_URL: 'https://app.ume.so', ...(project ? { UME_PROJECT: project } : {}) },
    };
    return {
      title: `Ume review ${snapshot.reference.artifact}`,
      summary: snapshot.events.at(-1)?.summary ?? 'Waiting for review feedback',
      label: 'Ume review',
      tone: snapshot.failure ? ('risk' as const) : ('neutral' as const),
      worker: { steps: ['Read the feedback in this watch’s recorded project, act on it, and report the outcome.'], read },
      helm: {
        steps: ['Keep feedback with its owning review chain. A completed task retires after its pending feedback tail is consumed.'],
        read,
      },
      rows: [
        { label: 'Artifact', value: snapshot.reference.artifact },
        { label: 'Project', value: project ?? 'Not resolved' },
        { label: 'Cursor', value: snapshot.cursor },
      ],
      links: [{ label: 'Open review', url: snapshot.reference.url }],
      actions: [],
      attention: [],
    };
  }
  failure(error: unknown) {
    return this.services.failure(error);
  }
  close(): void {
    /* Polls acquire no persistent provider resources. */
  }
}
