import type { GlassSnapshot } from '@lobstah/core';
import type { GlassBackend, GlassCapabilities } from '../backend.js';
import type { GlassRead, GlassVerdict, GlassWrite } from '../answers.js';
import { decisionOf, dispatchDetail, reportOf, wharfFileUrl, wharfSnapshot } from '../wharf-snapshot.js';
import type { DispatchView, WharfDetail, WharfDocument, WharfGlass } from '../wharf-model.js';
import { viewerDevice } from '../../../core/src/viewer-device.js';

/**
 * The hosted glass's backend: the wharf's cookie-only browser API on the
 * glass's own origin (/api/glass*). It reads the account and its jobs,
 * projects them onto the local glass's snapshot (wharf-snapshot.ts), and maps
 * the glass's writes onto the wharf's routes. The page never holds a boat or
 * dispatch credential: every request is same-origin with the session cookie,
 * and every write carries a fresh Idempotency-Key.
 */

/**
 * What the wharf fills: no PRs, stacks, grants, TODOs, notices, stats or
 * settings, and none of the local-only actions. It adds the account's boats,
 * messages and cancellation from a job, dismissing a review, and
 * acknowledging a clicked lob on the wharf, where every boat reads the ack.
 */
export const WHARF_CAPABILITIES: GlassCapabilities = {
  tabs: ['deck', 'dispatches', 'traps', 'boats', 'reviews', 'reports'],
  actions: new Set(['message-helm', 'cancel', 'review-dismiss', 'attention-ack']),
  daemon: false,
};

/** The wharf backend, and the account it last read (the hosted glass's boats and human requests). */
export interface WharfBackend extends GlassBackend {
  account(): WharfGlass | undefined;
}

/**
 * Marks the page as able to write. The shared UI holds back a write when the
 * snapshot has no token; the wharf authorizes each write by its cookie and
 * exact Origin instead, so this value is never sent.
 */
const WRITES_BY_COOKIE = 'wharf-session';

/** The largest Markdown the glass reads inline, as the hosted glass always has. */
const MARKDOWN_LIMIT = 65536;

export interface WharfBackendOptions {
  /** The wharf refused the session (401, or 403 for an account it does not admit): the host shows sign-in. */
  onSignedOut?: (status: 401 | 403) => void;
  /** The clock; tests pass a fixed one. */
  now?: () => number;
}

/** A wharf answer: its status, and its JSON body when it sent one. */
interface WharfAnswer<T> {
  ok: boolean;
  status: number;
  body: (T & { error?: string; message?: string }) | undefined;
}

export function createWharfBackend(options: WharfBackendOptions = {}): WharfBackend {
  const now = options.now ?? Date.now;
  let glass: WharfGlass | undefined;
  let jobs: DispatchView[] = [];
  /** Decision Markdown read so far, by file id. Wharf files never change, so each is read once. */
  const texts = new Map<string, string>();
  /** The last detail read per job, for its files' URLs. */
  const details = new Map<string, WharfDetail>();

  async function call<T>(path: string, init: RequestInit = {}): Promise<WharfAnswer<T>> {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (response.status === 401 || response.status === 403) options.onSignedOut?.(response.status);
    const text = await response.text();
    let body: WharfAnswer<T>['body'];
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { ok: response.ok, status: response.status, body };
  }

  /** A read that must succeed: the snapshot's own parts. */
  async function need<T>(path: string): Promise<T> {
    const answer = await call<T>(path);
    if (!answer.ok || answer.body === undefined) throw new Error(`${path} answered ${answer.status}`);
    return answer.body;
  }

  /** A write: JSON, same-origin, with a fresh idempotency key. Its verdict is the glass's {ok, reason}. */
  async function post(path: string, body: unknown): Promise<GlassWrite<GlassVerdict>> {
    const answer = await call<GlassVerdict>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    const reason = answer.ok ? undefined : (answer.body?.error ?? answer.body?.message ?? `The wharf answered ${answer.status}.`);
    return { ok: answer.ok, status: answer.status, body: answer.ok ? { ok: true } : { ok: false, reason } };
  }

  async function markdown(kind: 'documents' | 'dispatches', id: string, file: { id: string; size: number }): Promise<string> {
    if (file.size > MARKDOWN_LIMIT) throw new Error('Markdown exceeds 64 KiB; download it instead.');
    const response = await fetch(wharfFileUrl(kind, id, file.id), { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`File unavailable (${response.status})`);
    return response.text();
  }

  /** Read the Markdown of standing decisions not read yet. A file that fails is retried on the next poll. */
  async function decisionTexts(docs: readonly WharfDocument[]): Promise<void> {
    const unread = docs.filter((d) => d.kind === 'decision' && d.markdown && !texts.has(d.markdown.id));
    await Promise.all(
      unread.map(async (d) => {
        try {
          texts.set(d.markdown!.id, await markdown('documents', d.id, d.markdown!));
        } catch {
          // the card shows its title and options until the detail reads
        }
      }),
    );
  }

  async function load(): Promise<GlassSnapshot> {
    const [account, listed] = await Promise.all([need<WharfGlass>('/api/glass'), need<DispatchView[]>('/api/glass/dispatches')]);
    await decisionTexts(account.documents);
    glass = account;
    jobs = listed;
    return wharfSnapshot(account, jobs, now(), texts, WRITES_BY_COOKIE, viewerDevice(globalThis.navigator?.userAgent ?? ''));
  }

  const doc = (key: string): WharfDocument | undefined => glass?.documents.find((d) => d.id === key);
  const missing = <T>(): GlassRead<T> => ({ ok: false, status: 404 });

  return {
    capabilities: WHARF_CAPABILITIES,
    // The wake socket reads at once on a hint; the poll is the floor.
    pollMs: 15000,
    account: () => glass,
    async poll() {
      // The wharf sends no ETag; its wake socket and the 15 s poll say when to read again.
      return { kind: 'snapshot', snapshot: await load(), etag: null };
    },
    snapshot: load,
    async dispatch(id) {
      const answer = await call<WharfDetail>(`/api/glass/dispatches/${encodeURIComponent(id)}/detail`);
      if (!answer.ok || !answer.body) return { ok: false, status: answer.status };
      details.set(id, answer.body);
      return { ok: true, status: answer.status, data: dispatchDetail(answer.body) };
    },
    async decision(key) {
      const found = doc(key);
      if (!found || found.kind !== 'decision') return missing();
      if (found.markdown && !texts.has(found.markdown.id)) await decisionTexts([found]);
      return { ok: true, status: 200, data: decisionOf(found, found.markdown ? texts.get(found.markdown.id) : undefined) };
    },
    older: async () => missing(),
    stats: async () => missing(),
    settings: async () => missing(),
    async request<T extends GlassVerdict>(kind: string, payload: unknown): Promise<GlassWrite<T>> {
      const p = (payload ?? {}) as { key?: string; option?: string; text?: string; files?: unknown[]; dispatch?: string };
      const documentPath = (key: string | undefined, route: string) => `/api/glass/documents/${encodeURIComponent(key ?? '')}/${route}`;
      if (kind === 'decision-answer') {
        if (p.files?.length) return refused<T>('The wharf takes an option or text; attach files on the boat.');
        return (await post(documentPath(p.key, 'answer'), {
          ...(p.option ? { option: p.option } : {}),
          ...(p.text ? { text: p.text } : {}),
        })) as GlassWrite<T>;
      }
      // Opening a decision or report is reading it: the wharf records that once, for every boat and the glass.
      if (kind === 'decision-viewed' || kind === 'report-viewed') {
        if (doc(p.key ?? '')?.ack) return { ok: true, status: 200, body: { ok: true } as T };
        return (await post(documentPath(p.key, 'ack'), {})) as GlassWrite<T>;
      }
      // A message waits for the live helm to receipt it; a cancel fences the job's worker at once.
      if (kind === 'message')
        return (await post('/api/glass/requests', {
          id: crypto.randomUUID(),
          kind: 'message',
          dispatch: p.dispatch,
          text: p.text,
        })) as GlassWrite<T>;
      if (kind === 'cancel')
        return (await post(`/api/glass/dispatches/${encodeURIComponent(p.dispatch ?? '')}/cancel`, {})) as GlassWrite<T>;
      // A clicked lob: a document is acked as seen; a job's question or landing on the status it showed.
      if (kind === 'attention-ack') {
        const item = (payload as { items?: Array<{ key?: string; stateHash?: string }> } | undefined)?.items?.[0];
        const key = item?.key ?? '';
        const at = new Date(now()).toISOString();
        const acked = [{ key, stateHash: item?.stateHash ?? '', at, by: 'glass' }];
        const found = doc(key);
        if (found) {
          const done = found.ack ? { ok: true } : (await post(documentPath(key, 'ack'), {})).body;
          return { ok: !!done.ok, status: done.ok ? 200 : 409, body: (done.ok ? { ok: true, acked } : done) as T };
        }
        const job = key.startsWith('work:') ? jobs.find((j) => j.id === key.slice('work:'.length)) : undefined;
        if (!job?.status || item?.stateHash !== `${job.id}:${job.status.at}`)
          return refused<T>('This has changed since the page read it; read it again.');
        const done = await post(`/api/glass/dispatches/${encodeURIComponent(job.id)}/ack`, { at: job.status.at });
        return { ok: done.ok, status: done.status, body: (done.ok ? { ok: true, acked } : done.body) as T };
      }
      // The boat that drafted the review dismisses it; the wharf never touches GitHub.
      if (kind === 'review-dismiss')
        return (await post('/api/glass/requests', { id: crypto.randomUUID(), kind: 'review-dismiss', document: p.key })) as GlassWrite<T>;
      return refused<T>('This is not available on the wharf.');
    },
    focus: async () => refused('Window focus works only in the local glass.'),
    presence: async () => missing(),
    async report(key) {
      if (!glass) await load();
      const found = doc(key);
      if (!found || found.kind !== 'report') return missing();
      return { ok: true, status: 200, data: reportOf(found), token: WRITES_BY_COOKIE };
    },
    async reportText(key) {
      if (!glass) await load();
      const found = doc(key);
      if (!found?.markdown) return missing();
      try {
        return { ok: true, status: 200, data: await markdown('documents', found.id, found.markdown) };
      } catch {
        return { ok: false, status: 502 };
      }
    },
    fileUrl(owner, name) {
      if (owner.kind === 'trap') return '';
      if (owner.kind === 'dispatch') {
        const file = details.get(owner.id)?.files.find((f) => f.name === name);
        return file ? wharfFileUrl('dispatches', owner.id, file.id) : '';
      }
      const found = doc(owner.key);
      const file = found?.attachments.find((f) => f.name === name);
      return found && file ? wharfFileUrl('documents', found.id, file.id) : '';
    },
  };
}

/** A write the wharf does not take, refused before it leaves the page. */
function refused<T extends GlassVerdict>(reason: string): GlassWrite<T> {
  return { ok: false, status: 400, body: { ok: false, reason } as T };
}
