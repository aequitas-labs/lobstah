import type { GlassBeats, GlassSnapshot } from '@lobstah/core';
import { reportMarkdownUrl } from '../../src/glass-diff.js';
import type { GlassBackend, GlassPoll, GlassRead, GlassVerdict, GlassWrite } from '../backend.js';

/**
 * The local glass's backend: the daemon that serves the page, on the same
 * origin. Reads are `/data*`, `/report/*` and `/api/checklist`; writes are
 * `POST /requests` (and `/api/focus`), each carrying the page's write token.
 */
export const localBackend: GlassBackend = {
  async poll(etag) {
    const r = await fetch('/data', { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} });
    if (r.status === 304) return { kind: 'unchanged', beats: beatsOf(r) } satisfies GlassPoll;
    if (!r.ok) throw new Error(`/data answered ${r.status}`);
    return { kind: 'snapshot', etag: r.headers?.get('etag') ?? null, snapshot: (await r.json()) as GlassSnapshot };
  },
  async snapshot() {
    return (await (await fetch('/data')).json()) as GlassSnapshot;
  },
  dispatch: (id) => read(`/data/dispatch/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  decision: (key) => read(`/data/decision/${encodeURIComponent(key)}`),
  older: (kind, offset, limit) => read(`/data/older?kind=${kind}&offset=${offset}&limit=${limit}`, { cache: 'no-store' }),
  stats: () => read('/data/stats', { cache: 'no-store' }),
  settings: () => read('/data/settings', { cache: 'no-store' }),
  request: (kind, payload, token) =>
    write('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-token': token },
      body: JSON.stringify({ kind, payload }),
    }),
  focus: (trapId, token) =>
    write(`/api/focus/${encodeURIComponent(trapId)}`, { method: 'POST', headers: { 'x-lobstah-focus-token': token } }),
  presence: (page, visible, app) =>
    read(`/api/presence?page=${page}&vis=${visible ? 'visible' : 'hidden'}${app ? '&app=1' : ''}`, {
      method: 'POST',
      cache: 'no-store',
    }),
  async report(key) {
    const r = await fetch(`/report/${encodeURIComponent(key)}/meta`);
    if (!r.ok) return { ok: false, status: r.status };
    const token = r.headers?.get('x-lobstah-token') ?? undefined;
    return { ok: true, status: r.status, data: JSON.parse(await r.text()), ...(token ? { token } : {}) };
  },
  async reportText(key) {
    const r = await fetch(reportMarkdownUrl(key));
    return r.ok ? { ok: true, status: r.status, data: await r.text() } : { ok: false, status: r.status };
  },
  checklists: {
    load: (key) => read(`/api/checklist?key=${encodeURIComponent(key)}`, { cache: 'no-store' }),
    tick: (key, item, checked, token) => localBackend.request('checklist-tick', { key, item, checked }, token),
  },
};

/** A GET-style read: the JSON body only when the server answered it. */
async function read<T>(url: string, init?: RequestInit): Promise<GlassRead<T>> {
  const r = await fetch(url, init);
  return r.ok ? { ok: true, status: r.status, data: (await r.json()) as T } : { ok: false, status: r.status };
}

/** A write: the JSON body whatever the status, since a refusal carries its reason. */
async function write<T extends GlassVerdict>(url: string, init: RequestInit): Promise<GlassWrite<T>> {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json()) as T };
}

/** The beats an unchanged (304) answer carries in its header. */
function beatsOf(r: Response): GlassBeats | undefined {
  const raw = r.headers?.get('x-lobstah-beats');
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw)) as GlassBeats;
  } catch {
    return undefined;
  }
}
