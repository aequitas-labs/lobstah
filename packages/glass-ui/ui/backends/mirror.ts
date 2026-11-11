import type {
  GlassDecision,
  GlassDispatch,
  GlassOlderKind,
  GlassOlderPage,
  GlassReport,
  GlassSettings,
  GlassSnapshot,
  StatsPage,
} from '@lobstah/core';
import { ALL_CAPABILITIES } from '../backend.js';
import type { GlassBackend, GlassCapabilities, GlassFileOwner } from '../backend.js';
import type { GlassRead, GlassVerdict, GlassWrite } from '../answers.js';
import { decisionFileUrl, dispatchFileUrl, reportFileUrl, reportMarkdownUrl, trapFileUrl } from '../../src/glass-diff.js';
import { mergeMirror, mergeSettings, mergeStats } from '../mirror-merge.js';
import type { MirrorBoatSnapshot, MirrorBoatView, MirrorMerge } from '../mirror-merge.js';
import type { WharfBackend } from './wharf.js';
import type { WharfGlass } from '../wharf-model.js';
import { viewerDevice } from '../../../core/src/viewer-device.js';

/**
 * The hosted glass on mirror boats: each boat's own glass, merged into one
 * fleet (mirror-merge.ts). Reads and writes go to the row's boat through
 * the wharf's relay (`/api/glass/mirror/relay`), which hands the call to
 * the boat and answers with the boat's own response, so every tab and
 * review action works here as it does there. Review settings and helm chat
 * stay read-only. ↗ Open shows only on the trap rows of the boat this browser
 * runs on, found by a probe of that boat's glass over loopback.
 * Jobs on a wharf's own grounds stay as the wharf backend shows them, side
 * by side with the boats.
 */

/** A mirror boat as the wharf lists it, with its snapshot when the page does not hold it yet. */
interface ListedBoat {
  boat: string;
  name: string;
  at: string;
  etag: string;
  bytes: number;
  unchanged?: true;
  missing?: true;
  snapshot?: GlassSnapshot & { mirror?: { port: number; id: string } };
}

/**
 * What the mirror fills: every tab and action of the local glass, and the
 * wharf's Boats tab, but not the pet's presence (it shows items on its own
 * machine's screen), not ↗ Open, which shows only once the probe finds
 * this browser on a boat, and not Run: a run card runs only from the glass
 * at localhost on the Mac itself, so the hosted glass shows it as the wharf
 * does, without Run (the relay takes no run request either). Review settings
 * and helm chat are visible values, with no editing controls.
 */
export const MIRROR_CAPABILITIES: GlassCapabilities = {
  tabs: [...ALL_CAPABILITIES.tabs, 'boats'],
  actions: new Set([...ALL_CAPABILITIES.actions].filter((a) => !['presence', 'focus', 'run'].includes(a))),
  daemon: false,
};

/** The wharf's own jobs, decisions and reports, when the account has any: a source beside the boats. */
const WHARF_SOURCE = '@wharf';

/** Marks the page as able to write; the wharf authorizes each write by its cookie and Origin, so this is never sent. */
const WRITES_BY_COOKIE = 'wharf-session';

/** How long a write waits for its boat in all, polling past the relay's own wait. */
const WRITE_WAIT_MS = 60_000;

/** The probe's answer: the boat this browser runs on, and the token its glass takes for focus. */
interface Probe {
  boat: string;
  port: number;
  token: string;
  windowFocus: boolean;
}

export interface MirrorBackendOptions {
  /** The wharf backend: the account (boats, human requests) and the wharf's own grounds. */
  wharf: WharfBackend;
  /** The wharf refused the session: the host shows sign-in. */
  onSignedOut?: (status: 401 | 403) => void;
  now?: () => number;
  /** Loopback reads, for the focus probe and focus; the page's fetch by default. */
  loopback?: typeof fetch;
}

export interface MirrorBackend extends GlassBackend {
  /** The mirror boats shown, with their snapshots' ages. */
  boats(): MirrorBoatView[];
  /** The account, as the wharf backend last read it. */
  account(): WharfGlass | undefined;
}

export function createMirrorBackend(options: MirrorBackendOptions): MirrorBackend {
  const now = options.now ?? Date.now;
  const loopback = options.loopback ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sources = new Map<string, MirrorBoatSnapshot & { mirror?: { port: number; id: string } }>();
  let merged: MirrorMerge | undefined;
  let wharfPart: GlassSnapshot | undefined;
  let probe: Probe | undefined;
  let probedPorts = '';
  /** How many older rows each boat has paged in, per kind: each boat pages its own history. */
  const olderLoaded = new Map<string, Map<string, number>>();

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (response.status === 401 || response.status === 403) options.onSignedOut?.(response.status);
    return response;
  }

  /** The wharf's list: snapshots of the boats whose ETag the page does not hold. */
  async function list(): Promise<void> {
    const known = [...sources.values()].map((s) => `${s.boat}:${s.etag}`).join(',');
    const response = await call(`/api/glass/mirror${known ? `?known=${encodeURIComponent(known)}` : ''}`);
    if (!response.ok) throw new Error(`/api/glass/mirror answered ${response.status}`);
    const { boats } = (await response.json()) as { boats: ListedBoat[] };
    const seen = new Set<string>();
    for (const b of boats) {
      seen.add(b.boat);
      const held = sources.get(b.boat);
      if (b.snapshot)
        sources.set(b.boat, {
          boat: b.boat,
          name: b.name,
          at: b.at,
          etag: b.etag,
          snapshot: b.snapshot,
          ...(b.snapshot.mirror ? { mirror: b.snapshot.mirror } : {}),
        });
      else if (held) sources.set(b.boat, { ...held, name: b.name, at: b.at });
    }
    for (const boat of [...sources.keys()]) if (!seen.has(boat)) sources.delete(boat);
  }

  /** Whether this browser runs on one of the boats: its glass answers the probe with the id its snapshot carries. */
  async function probeBoats(): Promise<void> {
    const ports = [...sources.values()].map((s) => `${s.boat}:${s.mirror?.port}:${s.mirror?.id}`).join(',');
    if (ports === probedPorts) return;
    probedPorts = ports;
    probe = undefined;
    for (const s of sources.values()) {
      if (!s.mirror) continue;
      try {
        const r = await loopback(`http://127.0.0.1:${s.mirror.port}/api/mirror/probe`, {
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) continue;
        const answer = (await r.json()) as { mirror?: string; token?: string; windowFocus?: boolean };
        if (answer.mirror === s.mirror.id && typeof answer.token === 'string') {
          probe = { boat: s.boat, port: s.mirror.port, token: answer.token, windowFocus: answer.windowFocus === true };
          return;
        }
      } catch {
        // Not this boat, or no glass here: its traps keep their attach command.
      }
    }
  }

  async function load(): Promise<GlassSnapshot> {
    const [, wharf] = await Promise.all([list(), options.wharf.snapshot()]);
    // The wharf's own grounds show beside the boats only when it holds any of their work.
    wharfPart = wharf.dispatches.length || wharf.reports.length || wharf.decisions?.length ? wharf : undefined;
    await probeBoats();
    const parts: MirrorBoatSnapshot[] = [...sources.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (wharfPart) parts.push({ boat: WHARF_SOURCE, name: 'wharf', at: new Date(now()).toISOString(), etag: '', snapshot: wharfPart });
    const device = viewerDevice(globalThis.navigator?.userAgent ?? '');
    merged = mergeMirror(parts, now(), { onMachine: false, windowFocus: probe?.windowFocus ?? false, machine: '', device }, probe?.boat);
    return { ...merged.snapshot, focusToken: WRITES_BY_COOKIE };
  }

  const name = (boat: string) => sources.get(boat)?.name ?? boat;
  const stale = (boat: string) => merged?.boats.find((b) => b.boat === boat)?.stale ?? false;
  const route = <T>(value: T) => merged?.router.resolve(value) ?? { value, boat: undefined, ambiguous: false };
  const missing = <T>(): GlassRead<T> => ({ ok: false, status: 404 });

  /** One relayed call, waited for: the boat's own answer, or the page's refusal when no boat answers. */
  async function relay(boat: string, body: Record<string, unknown>): Promise<Response> {
    const id = crypto.randomUUID();
    const send = () =>
      call('/api/glass/mirror/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, boat, ...body }),
      });
    let response = await send();
    const deadline = now() + WRITE_WAIT_MS;
    // The relay waits; a boat slower than that is polled until it answers or the call expires.
    while (response.status === 202 && response.headers.get('X-Lobstah-Mirror-Call') !== 'answered' && now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      response = await call(`/api/glass/mirror/calls/${encodeURIComponent(id)}`);
    }
    return response;
  }

  async function relayRead<T>(boat: string, path: string, as: 'json' | 'text' = 'json'): Promise<GlassRead<T>> {
    const r = await relay(boat, { read: path });
    if (!r.ok || r.status === 202) return { ok: false, status: r.status === 202 ? 504 : r.status };
    return { ok: true, status: r.status, data: (as === 'json' ? await r.json() : await r.text()) as T };
  }

  /** A read of one row's record, from the boat that row came from. */
  async function readFor<T>(key: string, path: (id: string) => string, wharfRead: () => Promise<GlassRead<T>>): Promise<GlassRead<T>> {
    if (!merged) await load();
    const r = route(key);
    if (!r.boat) return missing();
    if (r.boat === WHARF_SOURCE) return wharfRead();
    return relayRead<T>(r.boat, path(r.value));
  }

  /** Files a person attached, sent to the wharf for their boat to fetch with the call. */
  async function uploadFiles(boat: string, files: ReadonlyArray<{ name: string; data: string }>): Promise<string[]> {
    const ids: string[] = [];
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const r = await call('/api/glass/mirror/files', {
        method: 'POST',
        headers: { 'X-File-Name': encodeURIComponent(f.name), 'X-Mirror-Boat': boat },
        body: bytes,
      });
      if (!r.ok) throw new Error(`the wharf refused ${f.name} (${r.status})`);
      ids.push(((await r.json()) as { id: string }).id);
    }
    return ids;
  }

  const capabilities = (): GlassCapabilities => {
    const actions = new Set(MIRROR_CAPABILITIES.actions);
    if (probe) actions.add('focus');
    // A fleet whose boats are all asleep is shown read-only: its controls would reach no one.
    const boats = merged?.boats.filter((b) => b.boat !== WHARF_SOURCE) ?? [];
    if (boats.length && boats.every((b) => b.stale)) actions.clear();
    if (wharfPart) for (const a of options.wharf.capabilities.actions) actions.add(a);
    return { tabs: MIRROR_CAPABILITIES.tabs, actions, daemon: false };
  };

  const backend: MirrorBackend = {
    get capabilities() {
      return capabilities();
    },
    pollMs: 2000,
    boats: () => merged?.boats.filter((b) => b.boat !== WHARF_SOURCE) ?? [],
    account: () => options.wharf.account(),
    async poll() {
      return { kind: 'snapshot', snapshot: await load(), etag: null };
    },
    snapshot: load,
    dispatch: (id) =>
      readFor<GlassDispatch>(
        id,
        (local) => `/data/dispatch/${encodeURIComponent(local)}`,
        () => options.wharf.dispatch(id),
      ),
    decision: (key) =>
      readFor<GlassDecision>(
        key,
        (local) => `/data/decision/${encodeURIComponent(local)}`,
        () => options.wharf.decision(key),
      ),
    async older(kind: GlassOlderKind, offset: number, limit: number): Promise<GlassRead<GlassOlderPage>> {
      // Each boat pages its own history from where it left off; the pages are merged, newest first.
      const loaded = olderLoaded.get(kind) ?? new Map<string, number>();
      if (offset === 0) loaded.clear();
      olderLoaded.set(kind, loaded);
      const pages = await Promise.all(
        [...sources.values()].map(async (s) => ({
          s,
          page: await relayRead<GlassOlderPage>(s.boat, `/data/older?kind=${kind}&offset=${loaded.get(s.boat) ?? 0}&limit=${limit}`),
        })),
      );
      const read = pages.filter(
        (p): p is { s: (typeof pages)[number]['s']; page: { ok: true; status: number; data: GlassOlderPage } } => p.page.ok,
      );
      if (!read.length) return { ok: false, status: pages[0]?.page.status ?? 404 };
      let items: Array<Record<string, unknown>> = [];
      let stacks: unknown[] = [];
      for (const { s, page } of read) {
        loaded.set(s.boat, (loaded.get(s.boat) ?? 0) + page.data.items.length);
        const labelled = (page.data.items as unknown as Array<Record<string, unknown>>).map((item) => {
          for (const field of ['id', 'key', 'url']) merged?.router.id(s.boat, item[field]);
          return sources.size > 1 && 'repo' in item
            ? { ...item, repo: merged?.router.label(s.boat, s.name, item.repo as string | undefined) }
            : item;
        });
        items = items.concat(labelled);
        if (page.data.kind === 'prs') stacks = stacks.concat(page.data.stacks);
      }
      const when = (item: Record<string, unknown>) => String(item.updated ?? item.at ?? item.updatedAt ?? '');
      items.sort((a, b) => when(b).localeCompare(when(a)));
      const total = read.reduce((n, p) => n + p.page.data.total, 0);
      const page = { kind, offset, total, items, ...(kind === 'prs' ? { stacks } : {}) } as unknown as GlassOlderPage;
      return { ok: true, status: 200, data: page };
    },
    async stats(): Promise<GlassRead<StatsPage>> {
      const pages = await Promise.all(
        [...sources.values()].map(async (s) => ({ name: s.name, page: await relayRead<StatsPage>(s.boat, '/data/stats') })),
      );
      const read = pages.flatMap((p) => (p.page.ok ? [{ name: p.name, stats: p.page.data }] : []));
      return read.length ? { ok: true, status: 200, data: mergeStats(read) } : { ok: false, status: pages[0]?.page.status ?? 404 };
    },
    async settings(): Promise<GlassRead<GlassSettings>> {
      const pages = await Promise.all(
        [...sources.values()].map(async (s) => ({ name: s.name, page: await relayRead<GlassSettings>(s.boat, '/data/settings') })),
      );
      const read = pages.flatMap((p) => (p.page.ok ? [{ name: p.name, settings: p.page.data }] : []));
      return read.length ? { ok: true, status: 200, data: mergeSettings(read) } : { ok: false, status: pages[0]?.page.status ?? 404 };
    },
    async request<T extends GlassVerdict>(kind: string, payload: unknown): Promise<GlassWrite<T>> {
      if (!merged) await load();
      const r = route(payload);
      if (r.ambiguous) return refused<T>('This names rows on more than one boat; act on one row at a time.');
      if (!r.boat) return refused<T>('This names no boat’s row.');
      if (r.boat === WHARF_SOURCE) return options.wharf.request<T>(kind, r.value, WRITES_BY_COOKIE);
      if (stale(r.boat)) return refused<T>(`${name(r.boat)} is asleep: its snapshot is old, so its rows are read-only until it is back.`);
      let value = r.value as Record<string, unknown> | null;
      let files: string[] | undefined;
      const attached = value && Array.isArray(value.files) ? (value.files as Array<{ name: string; data: string }>) : undefined;
      if (attached?.length) {
        try {
          files = await uploadFiles(r.boat, attached);
        } catch (error) {
          return refused<T>(error instanceof Error ? error.message : String(error));
        }
        const { files: _sent, ...rest } = value!;
        value = rest;
      }
      const response = await relay(r.boat, { write: { kind, payload: value }, ...(files ? { files } : {}) });
      if (response.status === 202)
        return { ok: false, status: 504, body: { ok: false, reason: `${name(r.boat)} did not answer; it may be asleep.` } as T };
      let body: T;
      try {
        body = (await response.json()) as T;
      } catch {
        body = { ok: response.ok } as T;
      }
      return { ok: response.ok, status: response.status, body };
    },
    async focus(trapId) {
      // Never relayed: the browser asks this machine's own glass, and only when the probe found it here.
      if (!probe) return refused('↗ Open works only on the boat the trap runs on.');
      const r = await loopback(`http://127.0.0.1:${probe.port}/api/mirror/focus/${encodeURIComponent(trapId)}`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'x-lobstah-focus-token': probe.token },
      });
      return { ok: r.ok, status: r.status, body: (await r.json()) as { message?: string; reason?: string } };
    },
    presence: async () => missing(),
    async report(key) {
      const read = await readFor<GlassReport>(
        key,
        (local) => `/report/${encodeURIComponent(local)}/meta`,
        () => options.wharf.report(key),
      );
      return read.ok ? { ...read, token: WRITES_BY_COOKIE } : read;
    },
    async reportText(key) {
      if (!merged) await load();
      const r = route(key);
      if (!r.boat) return missing();
      if (r.boat === WHARF_SOURCE) return options.wharf.reportText(key);
      return relayRead<string>(r.boat, reportMarkdownUrl(r.value), 'text');
    },
    fileUrl(owner: GlassFileOwner, fileName: string): string {
      const key = owner.kind === 'dispatch' ? owner.id : owner.kind === 'trap' ? owner.trapId : owner.key;
      const r = route(key);
      if (!r.boat) return '';
      if (r.boat === WHARF_SOURCE) return options.wharf.fileUrl(owner, fileName);
      const local = String(r.value);
      const path =
        owner.kind === 'dispatch'
          ? dispatchFileUrl(owner.lane, local, fileName)
          : owner.kind === 'trap'
            ? trapFileUrl(local, fileName)
            : owner.kind === 'decision'
              ? decisionFileUrl(local, fileName)
              : reportFileUrl(local, fileName);
      return `/api/glass/mirror/read?boat=${encodeURIComponent(r.boat)}&path=${encodeURIComponent(path)}`;
    },
    checklists: {
      load: (key) =>
        readFor(
          key,
          (local) => `/api/checklist?key=${encodeURIComponent(local)}`,
          async () => missing(),
        ),
      tick: (key, item, checked) => backend.request('checklist-tick', { key, item, checked }, WRITES_BY_COOKIE),
    },
  };
  return backend;
}

/** A write the page does not send, refused before it leaves. */
function refused<T extends GlassVerdict>(reason: string): GlassWrite<T> {
  return { ok: false, status: 400, body: { ok: false, reason } as T };
}
