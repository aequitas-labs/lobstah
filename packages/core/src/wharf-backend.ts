import type { BackendLocation, BackendMessage, ClaimReceipt, CoordinationBackend, DispatchInput, DispatchView, EventBatch, ReportInput, WharfAck, WharfAttentionList, WharfDocumentSummary, WharfMirrorCall } from './backend-model.js';

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
  const r = record(v); const d: DispatchInput = { id: string(r.id), brief: string(r.brief) };
  if (r.target !== undefined) {
    const target = record(r.target);
    if (target.kind !== 'configured-trap' || !['claude-desktop', 'terminal'].includes(String(target.surface)) || r.repo !== undefined || r.repoRemote !== undefined) throw new BackendError(502, 'invalid configured target');
    d.target = { kind: 'configured-trap', profile: string(target.profile), grounds: string(target.grounds), surface: target.surface as 'claude-desktop' | 'terminal', ...(target.parentDispatch === undefined ? {} : { parentDispatch: string(target.parentDispatch) }) };
  } else d.repo = string(r.repo);
  if (r.grounds !== undefined) d.grounds = string(r.grounds);
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
    if (!['review', 'pr', 'deploy', 'person', 'external', 'heavy'].includes(String(r.waitingOn))) throw new BackendError(502, 'invalid waiting kind');
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
function ack(v: unknown): WharfAck {
  const r = record(v); return { at: string(r.at), by: string(r.by).slice(0, 200) };
}
/**
 * The wharf's glass, as the wharf names it (`X-Lobstah-Glass`): an exact
 * HTTPS origin (HTTP for loopback tests only), never a path or credentials.
 * A click opens this address in a browser, so anything else is refused.
 */
export function glassOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return u.origin === value && (u.protocol === 'https:' || loopback) ? value : undefined;
  } catch { return undefined; }
}
/** One instance per named wharf/grounds. Never falls back to local on errors. */
export class WharfBackend implements CoordinationBackend {
  /** Where this wharf's glass is, once a response has named it. */
  glass?: string;
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
    this.glass = glassOrigin(response.headers.get('X-Lobstah-Glass')) ?? this.glass;
    try { return await responseValue(response); }
    catch (error) { if (error instanceof BackendError) throw error; throw new BackendError(503, 'backend response interrupted; state unknown'); }
  }
  async enqueue(d: DispatchInput, key: string): Promise<DispatchInput> { return input(await this.request('dispatches', d, key)); }
  async list(): Promise<DispatchView[]> {
    const value = await this.request('dispatches'); if (!Array.isArray(value)) throw new BackendError(502, 'invalid dispatch list');
    return value.map((v) => {
      const r = record(v); if (!['queued', 'active', 'done', 'cancelled'].includes(String(r.state))) throw new BackendError(502, 'invalid dispatch state');
      const unservable = r.unservable ? record(r.unservable) : undefined;
      let assistance: DispatchView['assistance'];
      if (r.assistance !== undefined) {
        if (!Array.isArray(r.assistance) || r.assistance.length > 32) throw new BackendError(502, 'invalid assistance results');
        assistance = r.assistance.map((value) => { const child = record(value); if (!Array.isArray(child.files) || child.files.length > 32) throw new BackendError(502, 'invalid assistance files'); return { id: string(child.id), state: string(child.state), ...(child.note === undefined ? {} : { note: string(child.note) }), files: child.files.map((value) => { const file = record(value); if (typeof file.size !== 'number' || file.size < 0) throw new BackendError(502, 'invalid assistance file size'); return { id: string(file.id), name: string(file.name), size: file.size }; }) }; });
      }
      return { ...input(r), ...(assistance ? { assistance } : {}), state: r.state as DispatchView['state'], ...(r.status ? { status: report(r.status) } : {}),
        ...(r.ack ? { ack: { ...ack(r.ack), status: string(record(r.ack).status) } } : {}),
        ...(r.boatName ? { boatName: string(r.boatName) } : {}),
        ...(r.workerId ? { workerId: string(r.workerId) } : {}), ...(r.claimedBoat ? { claimedBoat: string(r.claimedBoat) } : {}),
        ...(unservable ? { unservable: { repo: string(unservable.repo), note: string(unservable.note) } } : {}) };
    });
  }
  /**
   * The published decisions and reports of this account that are not
   * withdrawn (`GET documents`, read permission), reduced to what an
   * attention item needs. Markdown, options, attachments and answers stay on
   * the wharf.
   */
  async documents(): Promise<WharfDocumentSummary[]> {
    const value = await this.request('documents'); if (!Array.isArray(value)) throw new BackendError(502, 'invalid document list');
    return value.flatMap((v): WharfDocumentSummary[] => {
      const r = record(v); const id = string(r.id);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new BackendError(502, 'invalid document');
      // A kind this boat does not show as attention (a review) is not one of its documents.
      if (r.kind !== 'decision' && r.kind !== 'report') return [];
      if (r.published !== true || r.withdrawn) return [];
      return [{ id, kind: r.kind, title: string(r.title).slice(0, 200), at: string(r.at),
        ...(r.dispatch !== undefined ? { dispatch: string(r.dispatch) } : {}), ...(r.answer ? { answered: true as const } : {}),
        ...(r.ack ? { ack: ack(r.ack) } : {}) }];
    });
  }
  /** A person has seen this decision or report. The first ack stands; this returns the one that does. */
  async ackDocument(id: string, key: string): Promise<WharfAck> {
    return ack(record(await this.request(`documents/${encodeURIComponent(id)}/ack`, {}, key)).ack);
  }
  /** A person has seen this job's status of `statusAt`. Refused once the job has reported again. */
  async ackDispatch(id: string, statusAt: string, key: string): Promise<WharfAck & { status: string }> {
    const value = record(await this.request(`dispatches/${encodeURIComponent(id)}/ack`, { at: statusAt }, key));
    return { ...ack(value), status: string(value.status) };
  }
  async claim(key: string): Promise<ClaimReceipt | null> {
    const value = await this.request('claims', { worker: this.options.worker }, key); if (value === null) return null;
    const r = record(value);
    if (!Number.isSafeInteger(r.epoch) || Number(r.epoch) < 1) throw new BackendError(502, 'invalid claim epoch');
    return { dispatch: input(r.dispatch), epoch: Number(r.epoch), token: string(r.token), leaseUntil: string(r.leaseUntil) };
  }
  async heartbeat(id: string, key: string) { await this.request(`dispatches/${encodeURIComponent(id)}/heartbeat`, {}, key); }
  /** Forward-only facts returned by an accepted completion; never telemetry identity. */
  completion?: { withHelm: boolean | null; at: string };
  async report(id: string, r: ReportInput, key: string) {
    this.completion = undefined;
    const value = record(await this.request(`dispatches/${encodeURIComponent(id)}/report`, r, key));
    if (r.verb === 'done' && value.catch && typeof value.catch === 'object') {
      const c = record(value.catch);
      if ((c.withHelm === null || typeof c.withHelm === 'boolean') && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)))
        this.completion = { withHelm: c.withHelm as boolean | null, at: c.at };
    }
  }
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
  /** A mirror boat's put: its glass snapshot, gzipped. The wharf keeps only the latest. */
  async putMirrorSnapshot(gzip: Uint8Array): Promise<{ etag: string; bytes: number; at: string }> {
    const value = record(await responseValue(await this.raw('mirror/snapshot', 'PUT', gzip, { 'Content-Type': 'application/gzip' })));
    return { etag: string(value.etag), bytes: Number(value.bytes), at: string(value.at) };
  }
  /** Ask the boat that owns an item to acknowledge it, through the wharf's relay. */
  async ackMirrorAttention(boat: string, key: string, stateHash: string): Promise<void> {
    await this.request('mirror/attention/acks', { boat, key, stateHash }, undefined, 'POST');
  }
  /** Take a call before running it, so it runs once. */
  async takeMirrorCall(id: string): Promise<void> {
    await this.request(`mirror/calls/${encodeURIComponent(id)}/take`, {}, undefined, 'POST');
  }
  /** Answer a taken call with the local glass's own status, type and body. */
  async answerMirrorCall(id: string, status: number, contentType: string, body: Uint8Array): Promise<void> {
    await responseValue(await this.raw(`mirror/calls/${encodeURIComponent(id)}/answer`, 'POST', body, { 'Content-Type': contentType, 'X-Mirror-Status': String(status) }));
  }
  /** A file the person attached on the hosted glass, for one of this boat's calls. */
  async mirrorFile(id: string): Promise<{ name: string; bytes: Uint8Array }> {
    const response = await this.raw(`mirror/files/${encodeURIComponent(id)}`, 'GET');
    if (!response.ok) await responseValue(response);
    const name = decodeURIComponent(response.headers.get('X-File-Name') ?? 'attachment');
    return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  /** One request whose body or answer is bytes, not JSON. */
  private async raw(path: string, method: string, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await (this.options.fetch ?? fetch)(`${this.location.url}/v1/accounts/${encodeURIComponent(this.location.account)}/${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, ...headers },
        ...(body ? { body: new Uint8Array(body).buffer } : {}), signal: AbortSignal.timeout(30000), redirect: 'manual',
      });
    } catch { throw new BackendError(503, 'backend unavailable; state unknown (no local fallback)'); }
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
