import { DurableObject } from 'cloudflare:workers';
import type { DispatchInput, ReportInput, BackendEvent } from '../../../packages/core/src/backend-model.js';
import { ApiError, capability, digest, dispatchInput, hex, identifier, object, reportInput, requireThat, sameHash, text } from './protocol.js';

type Actor = { kind: 'helm'; id: string } | { kind: 'boat'; id: string } | { kind: 'dispatch'; id: string; epoch: number };
type DispatchRow = { id: string; data: string; state: string; worker: string | null; boat: string | null; epoch: number; lease: number; hash: string | null; nonce: string | null };
type BoatRow = { id: string; name: string; hash: string; revoked: number };
type WorkerRow = { id: string; boat: string; repo: string; seen: number };
type StoredResult = { status: number; value: unknown };
type FileRow = { id: string; dispatch: string; name: string; size: number; hash: string; ready: number };
export type Command = { account: string; helm: boolean; token: string; method: string; path: string; key?: string; session?: string; body: unknown; after?: string;
  prepared?: { id?: string; hash: string } };
const LEASE_MS = 90_000;
const HELM_MS = 120_000;

/** One account's only coordination authority. No alarms, timers or sockets. */
export class Account extends DurableObject<Env> {
  /** Serialises only R2 mutations in this live instance; ownership stays in SQL. */
  private fileTail: Promise<unknown> = Promise.resolve();
  async handle(command: string): Promise<string> { return JSON.stringify(await this.request(JSON.parse(command))); }
  async request(c: Command): Promise<StoredResult> {
    try {
      return c.path === 'boats' && c.method === 'POST' ? await this.issue(c)
        : c.path === 'claims' && c.method === 'POST' ? await this.claim(c) : await this.command(c);
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, value: { error: e.message } };
      throw e;
    }
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS boats (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, boat TEXT NOT NULL, repo TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, worker TEXT, boat TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0, hash TEXT, nonce TEXT);
      CREATE INDEX IF NOT EXISTS dispatch_worker ON dispatches(worker, state);
      CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dispatch TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idem (actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,key));
      CREATE TABLE IF NOT EXISTS recoveries (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (dispatch TEXT NOT NULL, epoch INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(dispatch,epoch));
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, dispatch TEXT NOT NULL, text TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
    `);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO meta VALUES (?,?)', 'generation', crypto.randomUUID());
  }
  private get(key: string): string | undefined {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', key).toArray()[0]?.value;
  }
  private set(key: string, value: string) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta VALUES (?,?)', key, value); }
  private dispatch(id: string): DispatchRow {
    const d = this.ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches WHERE id=?', id).toArray()[0];
    requireThat(d, 404, 'dispatch not found'); return d;
  }
  private event(kind: string, dispatch?: string) {
    this.ctx.storage.sql.exec('INSERT INTO events(kind,dispatch,at) VALUES (?,?,?)', kind, dispatch ?? null, new Date().toISOString());
  }
  private authenticate(c: Command, hash: string, now: number): Actor {
    if (c.helm) return { kind: 'helm', id: 'helm' };
    const pieces = c.token.split('.'); requireThat(pieces[1] === c.account, 403, 'wrong account');
    if (pieces[0] === 'b') {
      const m = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', pieces[2]).toArray()[0];
      requireThat(m && !m.revoked && sameHash(hash, m.hash), 401, 'invalid boat credential');
      return { kind: 'boat', id: m.id };
    }
    requireThat(pieces[0] === 'd', 401, 'invalid credential');
    const d = this.dispatch(pieces[2]); const epoch = Number(pieces[3]);
    // Recovery accepts an old token's proven epoch via an immutable capability,
    // checked separately below; it never changes dispatch authority.
    if (c.path === `dispatches/${d.id}/recovery`) {
      const old = this.ctx.storage.sql.exec<{hash: string}>('SELECT hash FROM claims WHERE dispatch=? AND epoch=?', d.id, epoch).toArray()[0];
      requireThat(old && sameHash(hash, old.hash), 401, 'invalid recovery credential');
      return { kind: 'dispatch', id: d.id, epoch };
    }
    requireThat(epoch === d.epoch && d.hash && sameHash(hash, d.hash), 409, 'stale claim epoch');
    requireThat(d.lease > now, 409, 'claim lease expired');
    return { kind: 'dispatch', id: d.id, epoch };
  }
  private expire(now: number) {
    for (const d of this.ctx.storage.sql.exec<DispatchRow>("SELECT * FROM dispatches WHERE state='active' AND lease<=?", now).toArray()) {
      const last = this.lastReport(d.id);
      if (last?.verb === 'paused' && Date.parse(last.until ?? '') > now) continue;
      this.ctx.storage.sql.exec("UPDATE dispatches SET state='queued',worker=NULL,boat=NULL,hash=NULL WHERE id=?", d.id);
      this.event('lease-lost', d.id); // unknown outcome, never inferred completion
    }
  }
  private lastReport(id: string): (ReportInput & { at: string }) | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM reports WHERE dispatch=? ORDER BY seq DESC LIMIT 1', id).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private helm(c: Command, actor: Actor, now: number) {
    requireThat(actor.kind === 'helm', 403, 'helm scope required');
    const seat = this.get('helm'); const h = seat ? JSON.parse(seat) : undefined;
    requireThat(h && h.session === c.session && h.until > now, 409, 'take or renew the helm lease first');
  }
  private budget(now: number) {
    const window = Math.floor(now / 60000); const b = JSON.parse(this.get('budget') ?? '{"window":0,"count":0}');
    if (b.window !== window) { b.window = window; b.count = 0; }
    requireThat(b.count < Number(this.env.REQUESTS_PER_MINUTE), 429, 'account rate limit');
    b.count++; this.set('budget', JSON.stringify(b));
  }
  private capacity() {
    const tables = ['boats', 'workers', 'dispatches', 'reports', 'events', 'idem', 'recoveries', 'claims', 'messages', 'files'];
    const count = tables.reduce((n, t) => n + this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n, 0);
    requireThat(count < Number(this.env.MAX_ROWS) && this.ctx.storage.sql.databaseSize < Number(this.env.MAX_ACCOUNT_BYTES), 507, 'account storage limit');
  }
  async command(c: Command): Promise<StoredResult> {
    const hash = await digest(c.token.startsWith('d.') ? c.token.split('.').at(-1)! : c.token);
    const fingerprint = await digest(JSON.stringify([c.method, c.path, c.body, c.session]));
    // Crypto awaits are before the transaction. Auth and ownership are checked
    // inside it, including revocations that arrived while hashing.
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      requireThat(!this.get('deleted'), 410, 'account deleted');
      const actor = this.authenticate(c, hash, now); this.budget(now); this.expire(now);
      if (c.method !== 'GET') {
        requireThat(c.key && /^[A-Za-z0-9_-]{1,128}$/.test(c.key), 400, 'Idempotency-Key required');
        const previous = this.ctx.storage.sql.exec<{ fingerprint: string; result: string }>('SELECT * FROM idem WHERE actor=? AND key=?', `${actor.kind}:${actor.id}`, c.key).toArray()[0];
        if (previous) { requireThat(previous.fingerprint === fingerprint, 409, 'idempotency key reused with different request'); return JSON.parse(previous.result); }
        this.capacity();
      }
      const result = this.execute(c, actor, now);
      if (c.method !== 'GET') this.ctx.storage.sql.exec('INSERT INTO idem VALUES (?,?,?,?)', `${actor.kind}:${actor.id}`, c.key!, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  private execute(c: Command, actor: Actor, now: number): StoredResult {
    const ok = (value: unknown = {}): StoredResult => ({ status: 200, value });
    const b = c.method === 'GET' ? {} : object(c.body);
    if (c.path === '_issue' && c.method === 'POST') {
      requireThat(actor.kind === 'helm' && c.prepared?.id, 403, 'helm scope required');
      const name = text(b.name, 80);
      this.ctx.storage.sql.exec('INSERT INTO boats(id,name,hash) VALUES (?,?,?)', c.prepared.id, name, c.prepared.hash);
      this.event('boat-issued'); return { status: 201, value: { id: c.prepared.id, name } };
    }
    if (c.path === '_claim' && c.method === 'POST') {
      requireThat(actor.kind === 'boat' && c.prepared, 403, 'boat scope required');
      const w = this.worker(b.worker, actor.id);
      requireThat(w.seen + LEASE_MS > now, 409, 'worker sign-on expired; renew first');
      requireThat(!this.ctx.storage.sql.exec("SELECT id FROM dispatches WHERE worker=? AND state='active'", w.id).toArray().length, 409, 'worker already has an open catch');
      // Addressed work remains sticky, including absent/stale workers.
      const candidates = this.ctx.storage.sql.exec<DispatchRow>("SELECT * FROM dispatches WHERE state='queued' ORDER BY rowid LIMIT 1000").toArray();
      const eligible = candidates.filter((d) => { const input: DispatchInput = JSON.parse(d.data); return input.for === w.id || (!input.for && input.repo === w.repo); });
      const d = eligible.find((d) => JSON.parse(d.data).for === w.id) ?? eligible[0];
      if (!d) return ok(null);
      const epoch = d.epoch + 1;
      this.ctx.storage.sql.exec("UPDATE dispatches SET state='active',worker=?,boat=?,epoch=?,lease=?,hash=? WHERE id=?", w.id, actor.id, epoch, now + LEASE_MS, c.prepared.hash, d.id);
      this.ctx.storage.sql.exec('INSERT INTO claims VALUES (?,?,?)', d.id, epoch, c.prepared.hash);
      this.event('claimed', d.id);
      return ok({ id: d.id, dispatch: JSON.parse(d.data), epoch, leaseUntil: new Date(now + LEASE_MS).toISOString() });
    }
    if (c.path === 'helm/take' && c.method === 'POST') {
      requireThat(actor.kind === 'helm', 403, 'helm scope required'); const session = identifier(b.session);
      const previous = JSON.parse(this.get('helm') ?? 'null');
      requireThat(!previous || previous.session === session || previous.until <= now || b.take === true, 409, 'helm held; explicit takeover required');
      const h = { session, until: now + HELM_MS }; this.set('helm', JSON.stringify(h)); this.event('helm-taken'); return ok(h);
    }
    if (c.path === 'helm/renew' || c.path === 'helm/release') {
      requireThat(c.method === 'POST', 405, 'POST required'); this.helm(c, actor, now);
      const h = { session: c.session, until: c.path.endsWith('release') ? 0 : now + HELM_MS };
      this.set('helm', JSON.stringify(h)); return ok(h);
    }
    if (c.path === 'boats' && c.method === 'GET') {
      requireThat(actor.kind === 'helm', 403, 'helm scope required');
      return ok(this.ctx.storage.sql.exec('SELECT id,name,revoked FROM boats').toArray());
    }
    if (c.path.startsWith('boats/') && c.path.endsWith('/revoke') && c.method === 'POST') {
      requireThat(actor.kind === 'helm', 403, 'helm scope required');
      this.ctx.storage.sql.exec('UPDATE boats SET revoked=1 WHERE id=?', identifier(c.path.split('/')[1])); this.event('boat-revoked'); return ok();
    }
    if (c.path === 'workers/sign-on' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required');
      const id = identifier(b.worker); const repo = identifier(b.repo);
      const old = this.ctx.storage.sql.exec<WorkerRow>('SELECT * FROM workers WHERE id=?', id).toArray()[0];
      requireThat(!old || old.boat === actor.id, 409, 'worker belongs to another boat');
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO workers VALUES (?,?,?,?)', id, actor.id, repo, now); this.event('worker-signed-on'); return ok({ id, repo });
    }
    if (c.path === 'workers/renew' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required'); const w = this.worker(b.worker, actor.id);
      this.ctx.storage.sql.exec('UPDATE workers SET seen=? WHERE id=?', now, w.id);
      this.ctx.storage.sql.exec("UPDATE dispatches SET lease=? WHERE worker=? AND boat=? AND state='active'", now + LEASE_MS, w.id, actor.id);
      return ok();
    }
    if (c.path === 'dispatches' && c.method === 'POST') {
      this.helm(c, actor, now); const d = dispatchInput(b);
      requireThat(!this.ctx.storage.sql.exec('SELECT id FROM dispatches WHERE id=?', d.id).toArray().length, 409, 'dispatch already exists');
      if (d.followUp) this.dispatch(d.followUp);
      this.ctx.storage.sql.exec("INSERT INTO dispatches(id,data,state) VALUES (?,?,'queued')", d.id, JSON.stringify(d)); this.event('queued', d.id); return ok(d);
    }
    if (c.path === 'dispatches' && c.method === 'GET') {
      requireThat(actor.kind === 'helm', 403, 'helm scope required');
      return ok(this.ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches ORDER BY rowid DESC LIMIT 100').toArray().map((d) => ({ ...JSON.parse(d.data), state: d.state, status: this.lastReport(d.id) })));
    }
    if (c.path === 'events' && c.method === 'GET') {
      requireThat(actor.kind === 'helm', 403, 'helm scope required');
      const generation = this.get('generation')!; const [g, n] = (c.after ?? `${generation}.0`).split('.');
      requireThat(g === generation && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)), 400, 'invalid account event cursor');
      const rows = this.ctx.storage.sql.exec<{ seq: number; kind: string; dispatch: string | null; at: string }>('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 100', Number(n)).toArray();
      const events: BackendEvent[] = rows.map((r) => ({ cursor: `${generation}.${r.seq}`, kind: r.kind, ...(r.dispatch ? { dispatchId: r.dispatch } : {}), at: r.at }));
      return ok({ events, cursor: events.at(-1)?.cursor ?? `${generation}.${n}` });
    }
    const parts = c.path.split('/');
    if (parts[0] === 'dispatches' && parts[1]) {
      const d = this.dispatch(identifier(parts[1])); const action = parts[2];
      requireThat(actor.kind === 'helm' || (actor.kind === 'dispatch' && actor.id === d.id), 403, 'dispatch scope required');
      if (!action && c.method === 'GET') return ok({ ...JSON.parse(d.data), state: d.state, status: this.lastReport(d.id) });
      if (action === 'cancel' && c.method === 'POST') {
        this.helm(c, actor, now); this.ctx.storage.sql.exec("UPDATE dispatches SET state='cancelled',hash=NULL WHERE id=?", d.id); this.event('cancelled', d.id); return ok();
      }
      if (action === 'heartbeat' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required');
        requireThat(d.state === 'active', 409, 'dispatch no longer active');
        requireThat(!this.ctx.storage.sql.exec<{ revoked: number }>('SELECT revoked FROM boats WHERE id=?', d.boat).toArray()[0]?.revoked, 403, 'boat revoked; lease cannot be extended');
        this.ctx.storage.sql.exec('UPDATE dispatches SET lease=? WHERE id=?', now + LEASE_MS, d.id); return ok({ leaseUntil: new Date(now + LEASE_MS).toISOString() });
      }
      if (action === 'report' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required'); const report = reportInput(b);
        requireThat(d.state === 'active', 409, 'dispatch no longer active');
        if (report.verb === 'done') requireThat(!this.ctx.storage.sql.exec('SELECT id FROM messages WHERE dispatch=? AND received=0', d.id).toArray().length, 409, 'unreceived messages; read and receipt before done');
        for (const file of report.evidence?.files ?? []) requireThat(this.ctx.storage.sql.exec('SELECT id FROM files WHERE id=? AND dispatch=? AND ready=1', file, d.id).toArray().length, 400, 'evidence file not uploaded to this dispatch');
        if (report.verb === 'paused' && !report.until) report.until = new Date(now + 86400_000).toISOString();
        this.ctx.storage.sql.exec('INSERT INTO reports(dispatch,data) VALUES (?,?)', d.id, JSON.stringify({ ...report, at: new Date(now).toISOString() }));
        const revoked = this.ctx.storage.sql.exec<{ revoked: number }>('SELECT revoked FROM boats WHERE id=?', d.boat).toArray()[0]?.revoked;
        this.ctx.storage.sql.exec('UPDATE dispatches SET state=?,lease=? WHERE id=?', ['done', 'failed'].includes(report.verb) ? 'done' : 'active', revoked ? d.lease : now + LEASE_MS, d.id);
        this.event(report.verb, d.id); return ok();
      }
      if (action === 'recovery' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required');
        const report = reportInput(b); const id = crypto.randomUUID();
        this.ctx.storage.sql.exec('INSERT INTO recoveries VALUES (?,?,?,?)', id, d.id, actor.epoch, JSON.stringify(report));
        this.event('recovery-submitted', d.id); return ok({ id, finalised: false });
      }
      if (action === 'recoveries' && c.method === 'GET') {
        requireThat(actor.kind === 'helm', 403, 'helm scope required');
        return ok(this.ctx.storage.sql.exec('SELECT id,epoch,data FROM recoveries WHERE dispatch=? LIMIT 100', d.id).toArray());
      }
      if (action === 'messages' && !parts[3] && c.method === 'POST') {
        this.helm(c, actor, now);
        const row = this.ctx.storage.sql.exec<{ id: number }>('INSERT INTO messages(dispatch,text) VALUES (?,?) RETURNING id', d.id, text(b.text, 16000)).one();
        this.event('message', d.id); return ok({ id: String(row.id) });
      }
      if (action === 'messages' && c.method === 'GET') {
        return ok(this.ctx.storage.sql.exec<{ id: number; text: string; received: number }>('SELECT id,text,received FROM messages WHERE dispatch=? AND received=0 ORDER BY id LIMIT 100', d.id).toArray().map((m) => ({ ...m, id: String(m.id), received: !!m.received })));
      }
      if (action === 'messages' && parts[3] && parts[4] === 'receipt' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required');
        requireThat(/^\d+$/.test(parts[3]), 400, 'invalid message id');
        requireThat(this.ctx.storage.sql.exec('SELECT id FROM messages WHERE id=? AND dispatch=?', parts[3], d.id).toArray().length, 404, 'message not found');
        this.ctx.storage.sql.exec('UPDATE messages SET received=1 WHERE id=? AND dispatch=?', parts[3], d.id); this.event('message-received', d.id); return ok();
      }
      if (action === 'files' && c.method === 'GET' && parts[3]) {
        const f = this.ctx.storage.sql.exec<FileRow>('SELECT * FROM files WHERE id=? AND dispatch=? AND ready=1', identifier(parts[3]), d.id).toArray()[0];
        requireThat(f, 404, 'file not found'); return ok(f);
      }
      if (action === 'files' && c.method === 'POST') {
        // Used only by upload(), which bounds and hashes the actual bytes.
        requireThat(actor.kind === 'dispatch' && d.state === 'active' && c.prepared?.id, 403, 'active dispatch token required');
        const name = text(b.name, 128); requireThat(!/[\x00-\x1f/\\]/.test(name), 400, 'invalid file name');
        requireThat(typeof b.size === 'number' && Number.isInteger(b.size) && b.size >= 0 && b.size <= Number(this.env.MAX_FILE_BYTES), 413, 'file too large');
        const sum = this.ctx.storage.sql.exec<{ n: number }>('SELECT coalesce(sum(size),0) AS n FROM files').one().n;
        requireThat(sum + b.size + this.ctx.storage.sql.databaseSize <= Number(this.env.MAX_ACCOUNT_BYTES), 507, 'account storage limit');
        this.ctx.storage.sql.exec('INSERT INTO files(id,dispatch,name,size,hash) VALUES (?,?,?,?,?)', c.prepared.id, d.id, name, b.size, c.prepared.hash);
        return ok({ id: c.prepared.id });
      }
    }
    throw new ApiError(404, 'route not found');
  }
  private worker(value: unknown, boat: string): WorkerRow {
    const w = this.ctx.storage.sql.exec<WorkerRow>('SELECT * FROM workers WHERE id=?', identifier(value)).toArray()[0];
    requireThat(w && w.boat === boat, 403, 'sign on this worker first'); return w;
  }

  /** Hashes only at rest. Issuance is shown once; retries return metadata. */
  async issue(c: Command): Promise<StoredResult> {
    requireThat(c.helm, 403, 'helm scope required');
    const b = object(c.body); const name = text(b.name, 80); const id = crypto.randomUUID();
    const token = `b.${c.account}.${id}.${crypto.randomUUID()}${crypto.randomUUID()}`; const hash = await digest(token);
    const base = await this.command({ ...c, path: '_issue', body: { name }, prepared: { id, hash } });
    return object(base.value).id === id ? { ...base, value: { ...object(base.value), token } } : base;
  }
  async claim(c: Command): Promise<StoredResult> {
    const key = c.key ?? '';
    // Token can be re-derived after a lost response without storing its secret.
    const secret = await capability(this.env.TOKEN_SECRET, `${c.account}:${key}:${c.token}`);
    const result = await this.command({ ...c, path: '_claim', prepared: { hash: await digest(secret) } });
    if (!result.value) return result;
    const r = object(result.value); const token = `d.${c.account}.${r.id}.${r.epoch}.${secret}`;
    // The persisted hash verifies the unguessable secret; account/id/epoch
    // are checked against this account's dispatch and claim history.
    return { ...result, value: { dispatch: r.dispatch, epoch: r.epoch, token, leaseUntil: r.leaseUntil } };
  }
  private serialFile<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.fileTail.catch(() => {}).then(fn); this.fileTail = result.catch(() => {}); return result;
  }
  async upload(command: string, bytes: Uint8Array): Promise<string> {
    return this.serialFile(async () => {
      try {
        const c: Command = JSON.parse(command);
        const hash = hex(await crypto.subtle.digest('SHA-256', bytes)); const id = crypto.randomUUID();
        c.body = { ...object(c.body), size: bytes.byteLength, hash };
        c.prepared = { id, hash };
        const reserve = await this.command(c); const file = identifier(object(reserve.value).id);
        const row = this.ctx.storage.sql.exec<FileRow>('SELECT * FROM files WHERE id=?', file).one();
        if (!row.ready) {
          await this.env.FILES.put(`${c.account}/${file}`, bytes, { sha256: hash, httpMetadata: { contentType: 'application/octet-stream', contentDisposition: 'attachment' } });
          // SQL tombstones cannot race deletion: deleteAccount uses this same
          // R2 serial queue, and all metadata remains durable across eviction.
          this.ctx.storage.sql.exec('UPDATE files SET ready=1 WHERE id=?', file); this.event('file-uploaded', row.dispatch);
        }
        return JSON.stringify({ status: 200, value: { id: file, bytes: row.size } });
      } catch (e) {
        if (e instanceof ApiError) return JSON.stringify({ status: e.status, value: { error: e.message } });
        throw e;
      }
    });
  }
  async deleteAccount(command: string): Promise<string> {
    return this.serialFile(async () => {
      const c: Command = JSON.parse(command);
      try {
        requireThat(c.helm, 403, 'helm scope required');
        requireThat(c.key && /^[A-Za-z0-9_-]{1,128}$/.test(c.key), 400, 'Idempotency-Key required');
        const keyHash = await digest(c.key);
        const prior = this.get('deleted'); requireThat(!prior || prior === keyHash, 410, 'account deleted');
        this.set('deleted', keyHash); // reject every other request before R2 I/O
        for (;;) {
          const files = await this.env.FILES.list({ prefix: `${c.account}/`, limit: 1000 });
          if (!files.objects.length) break;
          await this.env.FILES.delete(files.objects.map((f) => f.key));
        }
        this.ctx.storage.transactionSync(() => {
          for (const table of ['boats', 'workers', 'dispatches', 'reports', 'events', 'idem', 'recoveries', 'claims', 'messages', 'files']) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
          this.ctx.storage.sql.exec("DELETE FROM meta WHERE key!='deleted'");
        });
        // Keep only a tombstone: static operator-provisioned PATs cannot recreate
        // the deleted account. Remove its PAT hashes to complete deprovisioning.
        return JSON.stringify({ status: 200, value: { deleted: true } });
      } catch (e) {
        if (e instanceof ApiError) return JSON.stringify({ status: e.status, value: { error: e.message } });
        throw e;
      }
    });
  }
}
