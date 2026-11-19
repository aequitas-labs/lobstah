import { prWatchAttentionKinds } from './metadata.js';
import type { WatchAcknowledgementPolicy, WatchTriggerPolicy, WatchCommandPolicy, WatchRegistrationPolicy } from '../model.js';
import type { WatchNoticePolicy } from '../model.js';
import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import type { CommandWatchOptions } from '../command.js';
import type {
  WatchBatchObserver,
  WatchEffectHandler,
  WatchAutomation,
  WatchDispatchPolicy,
  WatchContext,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
  WatchValue,
} from '../model.js';

export const PR_WATCH_INPUT_PATTERN = '^(?:(?:pr:)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|https?://github\\.com/[^/]+/[^/]+/pull/[0-9]+(?:[/?#].*)?)$';

/** GitHub identity is canonical across report URLs, explicit keys and wharf reports. */
export interface PrWatchReference {
  owner: string;
  repo: string;
  number: number;
  key: string;
  url: string;
}
/** PR policy state retains each check’s consumed repair round independently of transport. */
export interface PrWatchState {
  checkRounds?: string[];
}
/** Only the source’s required legacy fields cross the one-time transport import. */
export interface PrWatchOptions extends CommandWatchOptions {
  legacy?: { checkRounds?: string[] };
}
export type PrWatchSnapshot = WatchSnapshot<PrWatchReference, PrWatchState, string, PrWatchOptions>;
export type PrWatchContext = WatchContext<PrWatchReference, PrWatchState, string, PrWatchOptions>;

/** Parse the historical key and URL spellings without querying GitHub. */
export function parsePrWatchReference(input: string): PrWatchReference | undefined {
  const match =
    /^(?:pr:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(input.trim()) ??
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(input.trim());
  if (!match) return undefined;
  const owner = match[1]!,
    repo = match[2]!,
    number = Number(match[3]);
  return { owner, repo, number, key: `pr:${owner}/${repo}#${number}`, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

export const prWatchReferenceSchema: WatchSchema<PrWatchReference> = {
    json: { type: 'object', required: ['key', 'owner', 'repo', 'number', 'url'] },
    parse(value) {
      if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string')
        throw new Error('Expected a PR watch reference');
      const reference = parsePrWatchReference(value.key);
      if (!reference) throw new Error('Invalid PR watch reference');
      for (const field of ['owner', 'repo', 'number', 'url'] as const)
        if ((value as Record<string, unknown>)[field] !== reference[field]) throw new Error('PR watch identity does not match its key');
      return reference;
    },
  };

/** Host services supply GitHub IO and existing evidence projections, never runtime policy. */
export interface PrWatchServices {
  acknowledgements?: WatchAcknowledgementPolicy;
  triggers?: WatchTriggerPolicy;
  commands?: WatchCommandPolicy;
  registration?: WatchRegistrationPolicy;
  noticePolicy?: WatchNoticePolicy;
  effectHandler?: WatchEffectHandler<PrWatchReference>;
  automation?: WatchAutomation<PrWatchReference, PrWatchState, string, PrWatchOptions>;
  dispatchPolicy?: WatchDispatchPolicy<PrWatchReference, PrWatchState, string, PrWatchOptions>;
  observe(context: PrWatchContext): WatchObservationBatch<string>;
  batchObserver: WatchBatchObserver<PrWatchReference, PrWatchState, string, PrWatchOptions>;
  present(snapshot: PrWatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
}

/** The PR source owns identity, observation, checkpoints, errors and instructions. */
export class PrWatchType extends BaseWatchType<PrWatchReference, PrWatchState, string, PrWatchOptions> {
  readonly acknowledgements: WatchAcknowledgementPolicy | undefined;
  readonly triggers: WatchTriggerPolicy | undefined;
  readonly commands: WatchCommandPolicy | undefined;
  readonly registration: WatchRegistrationPolicy | undefined;
  readonly descriptor = {
    id: 'pr', keyPrefix: 'pr:',
    apiVersion: 1 as const,
    stateVersion: 2,
    version: '1.1.0',
    attentionKinds: prWatchAttentionKinds,
  };
  readonly bindings = [
    { event: 'explicit' as const, field: 'key', pattern: PR_WATCH_INPUT_PATTERN },
    { event: 'report' as const, field: 'pr' },
    { event: 'legacy-command' as const, field: 'check', importsType: 'command', pattern: '[\\s\\S]+' },
  ];
  private readonly command = new CommandWatchType();
  readonly stateSchema: WatchSchema<PrWatchState> = {
    json: { type: 'object', additionalProperties: false, properties: { checkRounds: { type: 'array', items: { type: 'string' } } } },
    parse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'checkRounds'))
        throw new Error('Invalid PR watch policy state');
      const rounds = (value as PrWatchState).checkRounds;
      if (rounds !== undefined && (!Array.isArray(rounds) || rounds.some((round) => typeof round !== 'string')))
        throw new Error('Invalid PR check rounds');
      return rounds === undefined ? {} : { checkRounds: [...new Set(rounds)].slice(-100) };
    },
  };
  readonly cursorSchema = this.command.cursorSchema;
  readonly optionsSchema: WatchSchema<PrWatchOptions> = {
    json: {
      ...this.command.optionsSchema.json,
      properties: {
        ...(this.command.optionsSchema.json.properties as Record<string, WatchValue>),
        legacy: { type: 'object', properties: { checkRounds: { type: 'array', items: { type: 'string' } } } },
      },
    },
    parse: (value) => {
      const base = this.command.optionsSchema.parse(value);
      const legacy = (value as { legacy?: unknown }).legacy;
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return base;
      const rounds = this.stateSchema.parse({ checkRounds: (legacy as PrWatchState).checkRounds }).checkRounds;
      return rounds ? { ...base, legacy: { checkRounds: rounds } } : base;
    },
  };
  readonly referenceSchema = prWatchReferenceSchema;
  readonly batchObserver: PrWatchServices['batchObserver'];
  readonly effectHandler: PrWatchServices['effectHandler'];
  readonly noticePolicy: WatchNoticePolicy | undefined;
  readonly automation: PrWatchServices['automation'];
  readonly dispatchPolicy: PrWatchServices['dispatchPolicy'];
  constructor(private readonly services: PrWatchServices) {
    super();
    this.acknowledgements = services.acknowledgements;
    this.triggers = services.triggers;
    this.commands = services.commands;
    this.registration = services.registration;
    this.batchObserver = services.batchObserver;
    this.effectHandler = services.effectHandler;
    this.noticePolicy = services.noticePolicy;
    this.automation = services.automation;
    this.dispatchPolicy = services.dispatchPolicy;
  }
  identify(input: string): PrWatchReference | undefined {
    return parsePrWatchReference(input);
  }
  key(reference: PrWatchReference): string {
    return reference.key;
  }
  initialize(_reference: PrWatchReference, options: PrWatchOptions) {
    return {
      state: { ...(options.legacy?.checkRounds ? { checkRounds: options.legacy.checkRounds } : {}) },
      cursor: options.cursor ?? '0',
    };
  }
  restore(snapshot: WatchSnapshot): PrWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || ![1, 2].includes(snapshot.type.stateVersion))
      throw new Error('PR watch state version is unsupported');
    const options = this.optionsSchema.parse(snapshot.options),
      state = this.stateSchema.parse(snapshot.state);
    const rounds = [...new Set([...(state.checkRounds ?? []), ...(options.legacy?.checkRounds ?? [])])].slice(-100);
    return {
      ...snapshot,
      type: { ...this.descriptor },
      reference: this.referenceSchema.parse(snapshot.reference),
      state: rounds.length ? { checkRounds: rounds } : {},
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options,
    };
  }
  poll(context: PrWatchContext): WatchObservationBatch<string> {
    return this.services.observe(context);
  }
  reduce(snapshot: PrWatchSnapshot, batch: WatchObservationBatch<string>) {
    return { state: snapshot.state, cursor: batch.cursor, done: batch.done === true };
  }
  present(snapshot: PrWatchSnapshot): WatchPresentation {
    return this.services.present(snapshot);
  }
  failure(error: unknown): WatchFailure {
    return this.services.failure(error);
  }
  close(): void {
    /* PR reads acquire no persistent provider resources. */
  }
}
