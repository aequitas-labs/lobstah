import { BaseWatchType } from '../base.js';
import { CommandWatchType } from '../command.js';
import type { CommandWatchOptions, CommandWatchState } from '../command.js';
import type {
  WatchBatchObserver,
  WatchContext,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchSchema,
  WatchSnapshot,
} from '../model.js';

/** GitHub identity is canonical across report URLs, explicit keys and wharf reports. */
export interface PrWatchReference {
  owner: string;
  repo: string;
  number: number;
  key: string;
  url: string;
}
export type PrWatchSnapshot = WatchSnapshot<PrWatchReference, CommandWatchState, string, CommandWatchOptions>;
export type PrWatchContext = WatchContext<PrWatchReference, CommandWatchState, string, CommandWatchOptions>;

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

/** Host services supply GitHub IO and existing evidence projections, never runtime policy. */
export interface PrWatchServices {
  observe(context: PrWatchContext): WatchObservationBatch<string>;
  batchObserver: WatchBatchObserver<PrWatchReference, CommandWatchState, string, CommandWatchOptions>;
  present(snapshot: PrWatchSnapshot): WatchPresentation;
  failure(error: unknown): WatchFailure;
}

/** The PR source owns identity, observation, checkpoints, errors and instructions. */
export class PrWatchType extends BaseWatchType<PrWatchReference, CommandWatchState, string, CommandWatchOptions> {
  readonly descriptor = {
    id: 'pr',
    apiVersion: 1 as const,
    stateVersion: 1,
    version: '1.0.0',
    attentionKinds: [
      { kind: 'pr:draft', label: 'Draft', defaultEnabled: false },
      { kind: 'pr:review', label: 'Review', defaultEnabled: true },
      { kind: 'pr:checks', label: 'Checks', defaultEnabled: true },
      { kind: 'pr:conflict', label: 'Conflicts', defaultEnabled: true },
      { kind: 'pr:ready', label: 'Ready to merge', defaultEnabled: true },
    ],
  };
  readonly bindings = [
    { event: 'explicit' as const, field: 'key' },
    { event: 'report' as const, field: 'pr' },
    { event: 'legacy-command' as const, field: 'check', importsType: 'command', pattern: '\\bwatch check-pr\\s' },
  ];
  private readonly command = new CommandWatchType();
  readonly stateSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly optionsSchema = this.command.optionsSchema;
  readonly referenceSchema: WatchSchema<PrWatchReference> = {
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
  readonly batchObserver: PrWatchServices['batchObserver'];
  constructor(private readonly services: PrWatchServices) {
    super();
    this.batchObserver = services.batchObserver;
  }
  identify(input: string): PrWatchReference | undefined {
    return parsePrWatchReference(input);
  }
  key(reference: PrWatchReference): string {
    return reference.key;
  }
  initialize(_reference: PrWatchReference, options: CommandWatchOptions) {
    return { state: {}, cursor: options.cursor ?? '0' };
  }
  restore(snapshot: WatchSnapshot): PrWatchSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('PR watch state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: this.optionsSchema.parse(snapshot.options),
    };
  }
  poll(context: PrWatchContext): WatchObservationBatch<string> {
    return this.services.observe(context);
  }
  reduce(_snapshot: PrWatchSnapshot, batch: WatchObservationBatch<string>) {
    return { state: {}, cursor: batch.cursor, done: batch.done === true };
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
