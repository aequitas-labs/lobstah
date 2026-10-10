import { enqueue, storedDescriptor, pendingIds, activeIds } from './queue.js';
import { claimBait, heartbeatTrap } from './soak.js';
import type { TrapRegistration } from './soak.js';
import { appendStatus, readStatusLog } from './status.js';
import { mergeEvidence } from './evidence.js';
import { sendMessage, unhandled, acknowledge } from './inbox.js';
import type { Descriptor, Lane, StatusEntry, Verb, WaitingOn } from './types.js';

/** Only coordination travels. Local env, paths, sessions and setup never do. */
export interface DispatchInput {
  id: string;
  repo: string;
  brief: string;
  lane?: Lane;
  for?: string;
  followUp?: string;
  harness?: string;
  model?: string;
  effort?: string;
}
export interface ReportInput {
  verb: Verb;
  note?: string;
  waitingOn?: WaitingOn;
  link?: string;
  until?: string;
  evidence?: { prUrls?: string[]; files?: string[]; commits?: string[] };
}
export interface DispatchView extends DispatchInput {
  state: 'queued' | 'active' | 'done' | 'cancelled';
  status?: StatusEntry;
}
export interface ClaimReceipt {
  dispatch: DispatchInput;
  /** Hosted fencing only; local files retain their existing ownership rules. */
  epoch?: number;
  token?: string;
  leaseUntil?: string;
}
export interface BackendMessage { id: string; text: string; received: boolean }
export interface BackendEvent { cursor: string; kind: string; dispatchId?: string; at: string }
export interface EventBatch { events: BackendEvent[]; cursor: string }
export interface BackendLocation { kind: 'server'; url: string; account: string; tokenEnv: string }

/** An asynchronous seam; existing local callers need not opt into it. */
export interface CoordinationBackend {
  enqueue(input: DispatchInput, key: string): Promise<DispatchInput>;
  list(): Promise<DispatchView[]>;
  claim(key: string): Promise<ClaimReceipt | null>;
  heartbeat(id: string, key: string): Promise<void>;
  report(id: string, input: ReportInput, key: string): Promise<void>;
  send(id: string, text: string, key: string): Promise<void>;
  messages(id: string): Promise<BackendMessage[]>;
  receipt(id: string, message: string, key: string): Promise<void>;
}

/** Wrap the current file implementation, not a rewrite of its semantics. */
export function localBackend(reg: TrapRegistration): CoordinationBackend {
  const lane = (id: string): Lane => storedDescriptor(id, 'work') ? 'work' : 'chore';
  return {
    async enqueue(input) { enqueue(input, input.lane ?? 'work'); return input; },
    async list() {
      return (['work', 'chore'] as Lane[]).flatMap((l) => [
        ...pendingIds(l).map((id) => ({ id, state: 'queued' as const })),
        ...activeIds(l).map((id) => ({ id, state: 'active' as const })),
      ].flatMap(({ id, state }) => {
        const d = storedDescriptor(id, l);
        return d ? [{ ...coordinationDescriptor(d), lane: l, state, status: readStatusLog(id, l).at(-1) }] : [];
      }));
    },
    async claim() {
      const caught = claimBait(reg);
      return caught ? { dispatch: { ...coordinationDescriptor(caught.descriptor), lane: caught.lane } } : null;
    },
    async heartbeat(id) { heartbeatTrap(reg.trapId, { claimed: id }); },
    async report(id, input) {
      appendStatus(id, lane(id), input.verb, input.note, undefined, input, true);
      if (input.evidence?.prUrls || input.evidence?.commits) mergeEvidence(id, lane(id), {
        prUrls: input.evidence.prUrls, prUrl: input.evidence.prUrls?.[0], commits: input.evidence.commits,
      });
    },
    async send(id, text) { sendMessage(id, lane(id), text); },
    async messages(id) { return unhandled(id, lane(id)).map((m) => ({ id: m.file, text: m.text, received: false })); },
    async receipt(id, message) { acknowledge(id, lane(id), message); },
  };
}

/** Explicit whitelist: never spread a full local descriptor into HTTP. */
export function coordinationDescriptor(d: Descriptor): DispatchInput {
  return { id: d.id, repo: d.repo, brief: d.brief, for: d.for, followUp: d.followUp,
    harness: d.harness, model: d.model, effort: d.effort };
}

export function parseBackendLocation(raw: unknown): BackendLocation | undefined {
  if (raw === undefined) return undefined; // local files remain the default
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('backend must be a server configuration');
  const b = raw as Record<string, unknown>;
  if (b.kind !== 'server' || typeof b.url !== 'string' || typeof b.account !== 'string' ||
      typeof b.tokenEnv !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.account) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(b.tokenEnv)) throw new Error('backend requires kind=server, url, account and tokenEnv');
  const url = new URL(b.url);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('backend url must use HTTPS (HTTP is allowed only for loopback tests), without credentials');
  }
  return { kind: 'server', url: b.url.replace(/\/$/, ''), account: b.account, tokenEnv: b.tokenEnv };
}
