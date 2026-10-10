import type { WharfDocument, WharfDocumentInput, WharfFile, WharfHumanRequest } from '../../../packages/core/src/backend-model.js';
import { identifier, object, repoIdentity, requireThat, text } from './protocol.js';
import type { Actor, Command } from './account.js';

export const glassSchema = `
  CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS human_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worker_details (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`;
export const glassTables = ['documents', 'human_requests', 'worker_details'];
type Result = { status: number; value: unknown };
type Hooks = { helm: (c: Command, actor: Actor, now: number) => void; helmLive: (now: number) => boolean; event: (kind: string, dispatch?: string, note?: string) => void };
/** Pure synchronous SQL operations inside the account's auth/idempotency transaction. */
export class GlassState {
  constructor(private sql: SqlStorage, private hooks: Hooks) {}
  private get<T>(table: string, id: string): T | undefined {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM ${table} WHERE id=?`, id).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private put(table: string, id: string, value: unknown) { this.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?,?)`, id, JSON.stringify(value)); }
  private list<T>(table: string): T[] { return this.sql.exec<{ data: string }>(`SELECT data FROM ${table} ORDER BY rowid DESC LIMIT 100`).toArray().map((r) => JSON.parse(r.data)); }
  private document(id: string): WharfDocument {
    const d = this.get<WharfDocument>('documents', identifier(id)); requireThat(d, 404, 'document not found'); return d;
  }
  private person(actor: Actor) { requireThat(actor.kind === 'person', 403, 'signed-in person required'); }
  expire(now: number) {
    for (const row of this.sql.exec<{ id: string; data: string }>("SELECT * FROM human_requests WHERE json_extract(data,'$.state') IN ('queued','received','authorized') AND json_extract(data,'$.expiresAt')<=?", new Date(now).toISOString()).toArray()) {
      const r = JSON.parse(row.data) as WharfHumanRequest; r.state = 'expired'; this.put('human_requests', row.id, r);
      this.hooks.event('human-request-expired', r.dispatch, r.id);
    }
  }
  worker(id: string, body: Record<string, unknown>) {
    const info: Record<string, string> = {};
    for (const key of ['harness', 'session'] as const) if (body[key] !== undefined) info[key] = identifier(body[key]);
    this.put('worker_details', id, info);
  }
  workers() {
    return this.sql.exec<{ id: string; boat: string; boatName: string; repoRemote: string; seen: number; details: string | null; current: string | null }>(`SELECT w.id,w.boat,b.name AS boatName,w.repo AS repoRemote,w.seen,i.data AS details,
      (SELECT id FROM dispatches d WHERE d.worker=w.id AND d.state='active' LIMIT 1) AS current
      FROM workers w JOIN boats b ON b.id=w.boat LEFT JOIN worker_details i ON i.id=w.id LIMIT 100`).toArray().map(({ seen, details, ...w }) => ({ ...w, ...JSON.parse(details ?? '{}'), lastCheckIn: new Date(seen).toISOString() }));
  }
  boats() {
    return this.sql.exec<{ id: string; name: string; revoked: number; permissions: string; seen: number | null }>(`SELECT b.id,b.name,b.revoked,coalesce(p.permissions,'["work"]') AS permissions,
      (SELECT max(seen) FROM workers w WHERE w.boat=b.id) AS seen FROM boats b LEFT JOIN boat_permissions p ON p.boat=b.id LIMIT 100`).toArray().map(({ permissions, seen, ...b }) => ({ ...b, permissions: JSON.parse(permissions),
      lastCheckIn: seen ? new Date(seen).toISOString() : null,
      repos: this.sql.exec<{ repo: string }>('SELECT DISTINCT repo FROM workers WHERE boat=? LIMIT 100', b.id).toArray().map((r) => r.repo),
    }));
  }
  private files(id: string, values: unknown): WharfFile[] {
    requireThat(Array.isArray(values) && values.length <= 32, 400, 'at most 32 document files');
    requireThat(new Set(values).size === values.length, 400, 'duplicate document files');
    return values.map((value) => {
      const file = this.sql.exec<{ id: string; name: string; size: number }>('SELECT id,name,size FROM files WHERE id=? AND dispatch=? AND ready=1', identifier(value), `document:${id}`).toArray()[0];
      requireThat(file, 400, 'file does not belong to this document'); return file;
    });
  }
  /** File uploads are authoring, never a new direct person operational action. */
  uploadScope(c: Command, actor: Actor, now: number): string {
    this.hooks.helm(c, actor, now);
    const d = this.document(c.path.split('/')[1]!);
    requireThat(!d.published && !d.withdrawn, 409, 'document is already published or withdrawn');
    return `document:${d.id}`;
  }
  execute(c: Command, actor: Actor, now: number): Result | undefined {
    const parts = c.path.split('/'), b = c.method === 'GET' ? {} : object(c.body);
    const ok = (value: unknown = {}) => ({ status: 200, value });
    if (c.path === 'workers' && c.method === 'GET') return ok(this.workers());
    if (c.path === 'glass' && c.method === 'GET') return ok({ boats: this.boats(), workers: this.workers(), documents: this.list<WharfDocument>('documents').filter((d) => d.published && !d.withdrawn),
      requests: this.list<WharfHumanRequest>('human_requests').map((r) => ({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) })), helmLive: this.hooks.helmLive(now) });
    if (parts[0] === 'documents') {
      if (parts.length === 1 && c.method === 'GET') return ok(this.list<WharfDocument>('documents').filter((d) => d.published && !d.withdrawn));
      if (parts.length === 1 && c.method === 'POST') {
        this.hooks.helm(c, actor, now);
        const id = identifier(b.id), title = text(b.title, 200).trim();
        requireThat(title && ['decision', 'report'].includes(String(b.kind)), 400, 'document needs a title and kind');
        requireThat(!this.get('documents', id), 409, 'document already exists');
        const options = b.options ?? [];
        requireThat(Array.isArray(options) && options.length <= 6 && options.every((o) => typeof o === 'string' && o.trim() === o && o.length > 0 && o.length <= 80) && new Set(options).size === options.length, 400, 'invalid decision options');
        requireThat(b.kind === 'decision' || options.length === 0, 400, 'reports have no options');
        const d: WharfDocument = { id, title, kind: b.kind as WharfDocumentInput['kind'], options, attachments: [], published: false, at: new Date(now).toISOString(), author: `${actor.kind}:${actor.id}` };
        if (b.dispatch !== undefined) { d.dispatch = identifier(b.dispatch); requireThat(this.sql.exec('SELECT id FROM dispatches WHERE id=?', d.dispatch).toArray().length, 404, 'dispatch not found'); }
        this.put('documents', id, d); return ok(d);
      }
      const d = this.document(parts[1]!);
      if (parts.length === 2 && c.method === 'GET') return ok(d);
      if (parts.length === 3 && parts[2] === 'publish' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(!d.published && !d.withdrawn, 409, 'document already published or withdrawn');
        if (b.markdown !== undefined) {
          const [markdown] = this.files(d.id, [b.markdown]);
          requireThat(markdown!.size <= 65536 && /\.md$/i.test(markdown!.name), 400, 'markdown must be a .md file of at most 64 KiB'); d.markdown = markdown;
        }
        requireThat(d.kind !== 'report' || d.markdown, 400, 'report needs a markdown file');
        d.attachments = this.files(d.id, b.attachments ?? []);
        requireThat(!d.attachments.some((f) => f.id === d.markdown?.id) && new Set(d.attachments.map((f) => f.name)).size === d.attachments.length, 400, 'document attachment names must differ');
        if (b.replace !== undefined) {
          const previous = this.document(identifier(b.replace)); requireThat(previous.kind === 'decision' && !previous.withdrawn && !previous.answer, 409, 'no standing decision to replace');
          previous.withdrawn = true; this.put('documents', previous.id, previous);
        }
        d.published = true; this.put('documents', d.id, d); this.hooks.event(d.kind, d.dispatch, d.id); return ok(d);
      }
      if (parts.length === 3 && parts[2] === 'withdraw' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(d.kind === 'decision' && !d.answer && !d.withdrawn, 409, 'no standing decision to withdraw');
        d.withdrawn = true; this.put('documents', d.id, d); this.hooks.event('decision-withdrawn', d.dispatch, d.id); return ok(d);
      }
      if (parts.length === 3 && parts[2] === 'answer' && c.method === 'POST') {
        // Human input, like the local glass: never takes, renews or steals a helm seat.
        this.person(actor); requireThat(d.kind === 'decision' && d.published && !d.withdrawn && !d.answer, 409, 'decision is not standing');
        const option = b.option === undefined ? undefined : text(b.option, 80), answer = b.text === undefined ? undefined : text(b.text, 20000).trim();
        requireThat(option === undefined || d.options?.includes(option), 400, 'not a decision option'); requireThat(option || answer, 400, 'answer needs an option or text');
        d.answer = { ...(option ? { option } : {}), ...(answer ? { text: answer } : {}), at: new Date(now).toISOString(), by: actor.id };
        this.put('documents', d.id, d); this.hooks.event('decision-answer', d.dispatch, d.id); return ok(d);
      }
      if (parts.length === 4 && parts[2] === 'files' && c.method === 'GET') {
        const file = [d.markdown, ...d.attachments].find((f) => f?.id === identifier(parts[3])); requireThat(file, 404, 'document file not found'); return ok(file);
      }
    }
    if (parts[0] === 'requests') {
      if (parts[1] === 'starts' && parts.length === 2 && c.method === 'GET') {
        requireThat(actor.kind === 'boat', 403, 'boat scope required');
        return ok(this.list<WharfHumanRequest>('human_requests').filter((r) => r.kind === 'trap-request' && r.state === 'authorized' && r.boat === actor.id));
      }
      if (parts.length === 1 && c.method === 'GET') return ok(this.list<WharfHumanRequest>('human_requests').map((r) => ({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) })));
      if (parts.length === 1 && c.method === 'POST') {
        this.person(actor); const id = identifier(b.id); requireThat(!this.get('human_requests', id), 409, 'request already exists');
        requireThat(['message', 'trap-request'].includes(String(b.kind)), 400, 'invalid human request kind');
        const r: WharfHumanRequest = { id, kind: b.kind as WharfHumanRequest['kind'], by: actor.id, at: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: 'queued' };
        if (r.kind === 'message') { r.dispatch = identifier(b.dispatch); r.text = text(b.text, 16000); requireThat(this.sql.exec('SELECT id FROM dispatches WHERE id=?', r.dispatch).toArray().length, 404, 'dispatch not found'); }
        else { r.boat = identifier(b.boat); r.repo = repoIdentity(b.repo); requireThat(this.sql.exec('SELECT id FROM boats WHERE id=? AND revoked=0', r.boat).toArray().length, 404, 'boat not found'); }
        this.put('human_requests', id, r); this.hooks.event('human-request', r.dispatch, id); return ok({ ...r, waitingForHelm: !this.hooks.helmLive(now) });
      }
      const r = this.get<WharfHumanRequest>('human_requests', identifier(parts[1])); requireThat(r, 404, 'request not found');
      if (parts.length === 3 && parts[2] === 'start' && c.method === 'POST') {
        requireThat(actor.kind === 'boat' && r.boat === actor.id, 403, 'addressed boat required');
        requireThat(r.kind === 'trap-request' && r.state === 'authorized' && Date.parse(r.expiresAt) > now, 409, 'start request is not authorized or expired');
        r.state = 'fulfilled'; r.outcome = b.refused === undefined ? 'accepted by boat for launch' : text(b.refused, 200);
        this.put('human_requests', r.id, r); this.hooks.event('trap-start-accepted', undefined, r.id); return ok(r);
      }
      if (parts.length === 2 && c.method === 'GET') return ok({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) });
      if (parts.length === 3 && parts[2] === 'receipt' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(r.state === 'queued' && Date.parse(r.expiresAt) > now, 409, 'request already received or expired');
        r.state = 'received'; this.put('human_requests', r.id, r); this.hooks.event('human-request-received', r.dispatch, r.id); return ok(r);
      }
      if (parts.length === 3 && parts[2] === 'execute' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(r.state === 'received' && Date.parse(r.expiresAt) > now, 409, 'receipt a live request first');
        if (r.kind === 'trap-request') {
          r.state = 'authorized'; this.put('human_requests', r.id, r); this.hooks.event('trap-start-authorized', undefined, r.id); return ok(r);
        }
        const dispatch = this.sql.exec<{ state: string }>('SELECT state FROM dispatches WHERE id=?', r.dispatch!).toArray()[0];
        requireThat(dispatch && !['cancelled', 'done'].includes(dispatch.state), 409, 'dispatch is no longer open');
        this.sql.exec('INSERT INTO messages(dispatch,text) VALUES (?,?)', r.dispatch!, r.text!); r.state = 'fulfilled'; this.put('human_requests', r.id, r);
        this.hooks.event('message', r.dispatch, `human request ${r.id}`); return ok(r);
      }
    }
    return undefined;
  }
}
