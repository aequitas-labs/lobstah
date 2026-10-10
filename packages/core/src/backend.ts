import { enqueue, storedDescriptor, pendingIds, activeIds } from './queue.js';
import { claimBait, heartbeatTrap } from './soak.js';
import type { TrapRegistration } from './soak.js';
import { appendStatus, readStatusLog } from './status.js';
import { mergeEvidence } from './evidence.js';
import { sendMessage, unhandled, acknowledge } from './inbox.js';
import type { Descriptor, Lane } from './types.js';
import type { BackendLocation, CoordinationBackend, DispatchInput } from './backend-model.js';
export * from './backend-model.js';

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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('backend must be a wharf configuration');
  const b = raw as Record<string, unknown>;
  if (b.kind !== 'wharf' || typeof b.url !== 'string' || typeof b.account !== 'string' ||
      typeof b.tokenEnv !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.account) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(b.tokenEnv)) throw new Error('backend requires kind=wharf, url, account and tokenEnv');
  const url = new URL(b.url);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('backend url must use HTTPS (HTTP is allowed only for loopback tests), without credentials');
  }
  return { kind: 'wharf', url: b.url.replace(/\/$/, ''), account: b.account, tokenEnv: b.tokenEnv };
}
