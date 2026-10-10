import type { BackendLocation, BackendMessage, ClaimReceipt, CoordinationBackend, DispatchInput, DispatchView, EventBatch, ReportInput } from './backend-model.js';

export class BackendError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BackendError(502, 'invalid backend response');
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (typeof v !== 'string') throw new BackendError(502, 'invalid backend string'); return v;
}
function url(v: unknown): string {
  const value = string(v);
  try { const u = new URL(value); if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return value; } catch { /* invalid */ }
  throw new BackendError(502, 'invalid backend evidence URL');
}
async function responseValue(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) throw new BackendError(502, 'backend redirects are refused');
  const reader = response.body?.getReader();
  if (!reader) throw new BackendError(502, 'empty backend response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8 * 1024 * 1024) throw new BackendError(502, 'backend response too large');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new BackendError(502, 'invalid backend JSON'); }
  if (!response.ok) throw new BackendError(response.status, typeof record(value).error === 'string' ? String(record(value).error) : 'backend rejected request');
  return value;
}
function input(v: unknown): DispatchInput {
  const r = record(v); const d: DispatchInput = { id: string(r.id), repo: string(r.repo), brief: string(r.brief) };
  if (r.repoRemote !== undefined) d.repoRemote = string(r.repoRemote);
  for (const k of ['for', 'boat', 'followUp', 'harness', 'model', 'effort'] as const) if (r[k] !== undefined) d[k] = string(r[k]);
  if (r.lane === 'work' || r.lane === 'chore') d.lane = r.lane;
  return d;
}
function report(v: unknown): ReportInput & { at: string } {
  const r = record(v);
  if (!['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed'].includes(String(r.verb))) throw new BackendError(502, 'invalid report verb');
  const out: ReportInput & { at: string } = { verb: r.verb as ReportInput['verb'], at: string(r.at) };
  if (r.note !== undefined) out.note = string(r.note);
  if (r.until !== undefined) out.until = string(r.until);
  if (r.link !== undefined) out.link = url(r.link);
  if (r.waitingOn !== undefined) {
    if (!['review', 'pr', 'deploy', 'person', 'external'].includes(String(r.waitingOn))) throw new BackendError(502, 'invalid waiting kind');
    out.waitingOn = r.waitingOn as ReportInput['waitingOn'];
  }
  if (r.evidence !== undefined) {
    const e = record(r.evidence); out.evidence = {};
    for (const k of ['prUrls', 'files', 'commits'] as const) {
      if (e[k] !== undefined) { if (!Array.isArray(e[k]) || e[k].length > 32) throw new BackendError(502, 'invalid evidence'); out.evidence[k] = e[k].map(k === 'prUrls' ? url : string); }
    }
  }
  return out;
}
/** One instance per named wharf/grounds. Never falls back to local on errors. */
export class WharfBackend implements CoordinationBackend {
  constructor(public location: BackendLocation, private token: string,
    private options: { session?: string; worker?: string; fetch?: typeof fetch } = {}) {
    if (!token) throw new BackendError(401, `set the credential in ${location.tokenEnv}`);
  }
  async request(path: string, body?: unknown, key?: string, method?: string): Promise<unknown> {
    const url = `${this.location.url}/v1/accounts/${encodeURIComponent(this.location.account)}/${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (key) headers['Idempotency-Key'] = key;
    if (this.options.session) headers['X-Lobstah-Helm'] = this.options.session;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'manual' });
    } catch { throw new BackendError(503, 'backend unavailable; state unknown (no local fallback)'); }
    try { return await responseValue(response); }
    catch (error) { if (error instanceof BackendError) throw error; throw new BackendError(503, 'backend response interrupted; state unknown'); }
  }
  async enqueue(d: DispatchInput, key: string): Promise<DispatchInput> { return input(await this.request('dispatches', d, key)); }
  async list(): Promise<DispatchView[]> {
    const value = await this.request('dispatches'); if (!Array.isArray(value)) throw new BackendError(502, 'invalid dispatch list');
    return value.map((v) => {
      const r = record(v); if (!['queued', 'active', 'done', 'cancelled'].includes(String(r.state))) throw new BackendError(502, 'invalid dispatch state');
      const unservable = r.unservable ? record(r.unservable) : undefined;
      return { ...input(r), state: r.state as DispatchView['state'], ...(r.status ? { status: report(r.status) } : {}),
        ...(r.boatName ? { boatName: string(r.boatName) } : {}),
        ...(r.workerId ? { workerId: string(r.workerId) } : {}), ...(r.claimedBoat ? { claimedBoat: string(r.claimedBoat) } : {}),
        ...(unservable ? { unservable: { repo: string(unservable.repo), note: string(unservable.note) } } : {}) };
    });
  }
  async claim(key: string): Promise<ClaimReceipt | null> {
    const value = await this.request('claims', { worker: this.options.worker }, key); if (value === null) return null;
    const r = record(value);
    if (!Number.isSafeInteger(r.epoch) || Number(r.epoch) < 1) throw new BackendError(502, 'invalid claim epoch');
    return { dispatch: input(r.dispatch), epoch: Number(r.epoch), token: string(r.token), leaseUntil: string(r.leaseUntil) };
  }
  async heartbeat(id: string, key: string) { await this.request(`dispatches/${encodeURIComponent(id)}/heartbeat`, {}, key); }
  async report(id: string, r: ReportInput, key: string) { await this.request(`dispatches/${encodeURIComponent(id)}/report`, r, key); }
  async send(id: string, message: string, key: string) { await this.request(`dispatches/${encodeURIComponent(id)}/messages`, { text: message }, key); }
  async messages(id: string): Promise<BackendMessage[]> {
    const r = await this.request(`dispatches/${encodeURIComponent(id)}/messages`);
    if (!Array.isArray(r)) throw new BackendError(502, 'invalid messages');
    return r.map((m) => { const v = record(m); return { id: string(v.id), text: string(v.text), received: v.received === true }; });
  }
  async receipt(id: string, message: string, key: string) { await this.request(`dispatches/${encodeURIComponent(id)}/messages/${encodeURIComponent(message)}/receipt`, {}, key); }
  async events(after?: string): Promise<EventBatch> {
    const r = record(await this.request(`events${after ? `?after=${encodeURIComponent(after)}` : ''}`));
    if (!Array.isArray(r.events)) throw new BackendError(502, 'invalid events');
    return { cursor: string(r.cursor), events: r.events.map((v) => {
      const e = record(v); return { cursor: string(e.cursor), kind: string(e.kind), at: string(e.at), ...(e.dispatchId ? { dispatchId: string(e.dispatchId) } : {}), ...(e.note ? { note: string(e.note) } : {}), ...(e.boatName ? { boatName: string(e.boatName) } : {}) };
    }) };
  }
  async wait(after: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<EventBatch> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    while (!signal?.aborted) {
      const batch = await this.events(after);
      if (batch.events.length || Date.now() >= deadline) return batch;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, Math.max(0, Math.min(1000, deadline - Date.now())));
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
    throw new BackendError(499, 'wait cancelled');
  }
  async upload(id: string, name: string, bytes: Uint8Array, key: string): Promise<string> {
    return this.uploadPath(`dispatches/${encodeURIComponent(id)}/files`, name, bytes, key);
  }
  async uploadDocument(id: string, name: string, bytes: Uint8Array, key: string): Promise<string> {
    return this.uploadPath(`documents/${encodeURIComponent(id)}/files`, name, bytes, key);
  }
  private async uploadPath(path: string, name: string, bytes: Uint8Array, key: string): Promise<string> {
    const response = await (this.options.fetch ?? fetch)(`${this.location.url}/v1/accounts/${encodeURIComponent(this.location.account)}/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Idempotency-Key': key, 'X-File-Name': name,
        ...(this.options.session ? { 'X-Lobstah-Helm': this.options.session } : {}) },
      body: new Uint8Array(bytes).buffer, signal: AbortSignal.timeout(30000), redirect: 'manual',
    });
    const result = record(await responseValue(response));
    return string(result.id);
  }
}
