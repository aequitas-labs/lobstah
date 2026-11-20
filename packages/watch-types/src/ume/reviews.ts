import { BaseWatchType } from '../base.js';
import type {
  WatchContext,
  WatchEffectHandler,
  WatchFailure,
  WatchObservationBatch,
  WatchPresentation,
  WatchRegistrationPolicy,
  WatchSchema,
  WatchSnapshot,
} from '../model.js';
import type { WatchItem, WatchItemStatus, WatchSourceBrand } from '../items.js';

/**
 * Incoming ume reviews: the approval requests a person's ume Needs You lists
 * for one explicitly configured project. This is separate from the ume
 * artifact-feedback adapter, which wakes a worker on an artifact it already
 * watches: a pending review appears here without a dispatch or a
 * per-artifact watch, and reading it consumes no feedback cursor and clears
 * no human task. Approving stays in ume; the card opens it there.
 */

export const UME_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const UME_SOURCE: WatchSourceBrand = { id: 'ume', name: 'ume', icon: { glyph: 'ume' } };

/** One project's review watch, keyed by the project; the reviewer is the person the stored ume token acts for. */
export interface UmeReviewReference {
  key: string;
  project: string;
}

/** One formal request: its approval reference and when it was made. A new reference or time is a new review episode. */
export interface UmeReviewEpisode {
  ref: string;
  since: string;
}

/** One artifact that waits on the reviewer, hydrated from the project's artifact listing. */
export interface UmeReviewRequest {
  artifact: string;
  title: string;
  url: string;
  /** Every pending formal request for this artifact, newest first; they roll into one card. */
  episodes: UmeReviewEpisode[];
  owner?: { id: string; name?: string };
  revision?: number;
  /** The artifact's role in its set ("plan"), when it has one. */
  role?: string;
  /** Set when a complete listing confirmed the reviewer can no longer read the artifact. */
  unavailable?: string;
}

/** The last complete, successful read of the project's pending reviews. */
export interface UmeReviewState {
  reviewer: string | null;
  projectName: string | null;
  requests: UmeReviewRequest[];
  /** When this read completed; absent until the first one. */
  readAt: string | null;
}
export type UmeReviewOptions = Record<string, never>;
export type UmeReviewSnapshot = WatchSnapshot<UmeReviewReference, UmeReviewState, string, UmeReviewOptions>;
export type UmeReviewContext = WatchContext<UmeReviewReference, UmeReviewState, string, UmeReviewOptions>;

/** Host services: the ume reads, the reviewer's acknowledgements, and the effect that records one. */
export interface UmeReviewServices {
  /** Read needs and hydrate them; throw unless the whole listing was read. */
  read(context: UmeReviewContext): UmeReviewState;
  failure(error: unknown): WatchFailure;
  /** The episode the reviewer last opened for each item. */
  seen(): Record<string, string>;
  effectHandler?: WatchEffectHandler<UmeReviewReference>;
  registration?: WatchRegistrationPolicy;
}

/** The acknowledging effect: opening an incoming review records the episode it showed. */
export const UME_REVIEW_SEEN = 'ume-review-seen';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** An episode's identity: its formal request reference and time. */
export const umeEpisodeKey = (episode: UmeReviewEpisode): string => `${episode.ref}@${episode.since}`;
/** The item's identity: project, reviewer and artifact. Revisions and episodes change; this does not. */
export const umeReviewItemId = (project: string, reviewer: string, artifact: string): string => `${project}/${reviewer}/${artifact}`;

/** Parse the persisted state, refusing anything a read would not have produced. */
export function parseUmeReviewState(value: unknown): UmeReviewState {
  if (!isObject(value) || !Array.isArray(value.requests)) throw new Error('Invalid ume review state');
  const requests = value.requests.map((request): UmeReviewRequest => {
    if (!isObject(request) || !text(request.artifact) || typeof request.title !== 'string' || !text(request.url) || !Array.isArray(request.episodes))
      throw new Error('Invalid ume review request');
    const episodes = request.episodes.map((episode) => {
      if (!isObject(episode) || !text(episode.ref) || !text(episode.since)) throw new Error('Invalid ume review episode');
      return { ref: episode.ref, since: episode.since };
    });
    const owner = isObject(request.owner) && text(request.owner.id) ? { id: request.owner.id, ...(text(request.owner.name) ? { name: request.owner.name } : {}) } : undefined;
    return {
      artifact: request.artifact,
      title: request.title,
      url: request.url,
      episodes,
      ...(owner ? { owner } : {}),
      ...(typeof request.revision === 'number' ? { revision: request.revision } : {}),
      ...(text(request.role) ? { role: request.role } : {}),
      ...(text(request.unavailable) ? { unavailable: request.unavailable } : {}),
    };
  });
  return {
    reviewer: text(value.reviewer) ? value.reviewer : null,
    projectName: text(value.projectName) ? value.projectName : null,
    requests,
    readAt: text(value.readAt) ? value.readAt : null,
  };
}

/** One project's incoming reviews, owned by the home helm and observed without any provider write. */
export class UmeReviewWatchType extends BaseWatchType<UmeReviewReference, UmeReviewState, string, UmeReviewOptions> {
  readonly descriptor = { id: 'ume-reviews', keyPrefix: 'ume-reviews:', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly bindings = [{ event: 'local' as const, field: 'ume.reviewProject' }];
  readonly referenceSchema: WatchSchema<UmeReviewReference> = {
    json: { type: 'object', required: ['key', 'project'], properties: { key: { type: 'string' }, project: { type: 'string' } } },
    parse(value) {
      if (!isObject(value) || typeof value.project !== 'string' || !UME_PROJECT_ID.test(value.project)) throw new Error('A ume project is required');
      const key = `ume-reviews:${value.project}`;
      if (value.key !== key) throw new Error('Ume review watch project does not match its key');
      return { key, project: value.project };
    },
  };
  readonly stateSchema: WatchSchema<UmeReviewState> = { json: { type: 'object' }, parse: parseUmeReviewState };
  readonly cursorSchema: WatchSchema<string> = {
    json: { type: 'string' },
    parse(value) {
      if (typeof value !== 'string') throw new Error('Ume review cursor must be a string');
      return value;
    },
  };
  readonly optionsSchema: WatchSchema<UmeReviewOptions> = {
    json: { type: 'object' },
    parse: () => ({}),
  };
  readonly effectHandler: UmeReviewServices['effectHandler'];
  readonly registration: UmeReviewServices['registration'];
  constructor(private readonly services: UmeReviewServices) {
    super();
    this.effectHandler = services.effectHandler;
    this.registration = services.registration;
  }
  identify(input: string): UmeReviewReference | undefined {
    const project = input.startsWith('ume-reviews:') ? input.slice('ume-reviews:'.length) : input;
    return UME_PROJECT_ID.test(project) ? { key: `ume-reviews:${project}`, project } : undefined;
  }
  key(reference: UmeReviewReference): string {
    return reference.key;
  }
  initialize() {
    return { state: { reviewer: null, projectName: null, requests: [], readAt: null }, cursor: '' };
  }
  restore(snapshot: WatchSnapshot): UmeReviewSnapshot {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Ume review state version is unsupported');
    return {
      ...snapshot,
      reference: this.referenceSchema.parse(snapshot.reference),
      state: this.stateSchema.parse(snapshot.state),
      cursor: this.cursorSchema.parse(snapshot.cursor),
      options: {},
    };
  }
  /** A complete read becomes the payload; any incomplete or failed read throws and keeps the last good items. */
  poll(context: UmeReviewContext): WatchObservationBatch<string> {
    const state = this.services.read(context);
    return { cursor: JSON.stringify(state.requests), events: [], payload: JSON.parse(JSON.stringify(state)) };
  }
  reduce(snapshot: UmeReviewSnapshot, batch: WatchObservationBatch<string>) {
    // Only a complete successful read replaces the pending set; withdrawals and completions leave it here.
    const state = batch.payload === undefined || batch.failure ? snapshot.state : parseUmeReviewState(batch.payload);
    return { state, cursor: batch.payload === undefined || batch.failure ? snapshot.cursor : batch.cursor, done: false };
  }
  present(snapshot: UmeReviewSnapshot): WatchPresentation {
    const { project } = snapshot.reference;
    const state = snapshot.state;
    const seen = this.services.seen();
    // A failed or partial read keeps the last good items, marked stale with the reason.
    const stale: WatchItemStatus | undefined = snapshot.failure
      ? { code: 'stale', label: 'stale', category: 'health', meaning: 'caution', detail: snapshot.failure.message }
      : undefined;
    const reviewer = state.reviewer ?? 'reviewer';
    const items = state.requests.map((request): WatchItem => {
      const id = umeReviewItemId(project, reviewer, request.artifact);
      const episode = request.episodes[0];
      const episodeKey = episode ? umeEpisodeKey(episode) : 'none';
      const statuses: WatchItemStatus[] = [
        {
          code: 'approval-requested',
          label: 'approval requested',
          category: 'workflow',
          meaning: 'pending',
          ...(request.episodes.length > 1 ? { detail: `${request.episodes.length} pending requests` } : {}),
        },
        ...(request.unavailable
          ? [
              {
                code: 'unavailable',
                label: 'unavailable',
                category: 'health' as const,
                meaning: 'failed' as const,
                detail: request.unavailable,
                // The source's health explanation lives with its watch.
                target: { hash: '#watches' },
              },
            ]
          : []),
        ...(stale ? [stale] : []),
      ];
      const reference = request.revision === undefined ? undefined : `${request.role ? `${request.role} ` : ''}r${request.revision}`;
      return {
        id,
        revision: `${request.revision ?? 0}:${request.episodes.map(umeEpisodeKey).join(',')}`,
        title: request.title,
        kind: 'document',
        glyph: { kind: 'document', variants: { completed: 'document-check' } },
        lifecycle: { phase: 'active', label: 'Active' },
        statuses,
        attention: request.unavailable ? 'error' : 'needs-you',
        notification: {
          revision: episodeKey,
          unread: seen[id] !== episodeKey,
          seen: seen[id] === episodeKey,
          action: UME_REVIEW_SEEN,
        },
        standing: !request.unavailable,
        ...(request.owner
          ? { person: { id: request.owner.id, ...(request.owner.name ? { name: request.owner.name } : {}), role: 'requested by' } }
          : {}),
        metadata: [
          { kind: 'project', value: state.projectName ?? project },
          ...(episode ? [{ kind: 'time' as const, value: episode.since }] : []),
          ...(reference ? [{ kind: 'revision' as const, value: reference }] : []),
        ],
        ...(episode ? { requestedAt: episode.since } : {}),
        // An unavailable artifact loses its way out and points at its source's health instead.
        target: request.unavailable ? { hash: '#watches' } : { href: request.url },
        actions: request.unavailable
          ? []
          : [{ id: 'open', label: 'Open in ume', placement: 'open', enabled: true, acknowledges: true, binding: { link: { href: request.url } } }],
        surfaces: { list: ['reviews'], home: 'reviews' },
      };
    });
    return {
      version: 2,
      source: UME_SOURCE,
      surfaces: ['reviews'],
      glyph: 'document',
      items,
      title: `Incoming reviews · ${state.projectName ?? project}`,
      summary: `${items.length} reviews requested`,
      label: 'Incoming reviews',
      tone: snapshot.failure ? 'warning' : 'neutral',
      worker: { steps: ['Incoming reviews are for a person to approve in ume; a worker does not act on them.'] },
      helm: {
        steps: ['Approvals stay in ume. Point the person at the card, or at the artifact in ume, rather than approving with an agent token.'],
        read: { executable: 'ume', args: ['needs', '--kind', 'approval', '--full', '--json'], environment: { UME_PROJECT: project } },
      },
      rows: [
        { label: 'Project', value: state.projectName ? `${state.projectName} (${project})` : project },
        { label: 'Pending', value: String(items.length) },
        ...(state.readAt ? [{ label: 'Last complete read', value: state.readAt }] : []),
      ],
      links: [],
      actions: [{ id: UME_REVIEW_SEEN, label: 'Mark seen', requiresAuthority: true }],
      attention: [],
    };
  }
  failure(error: unknown): WatchFailure {
    return this.services.failure(error);
  }
  close(): void {
    /* Reading needs holds no provider resources, and ume keeps the human tasks. */
  }
}
