import { DurableObject } from 'cloudflare:workers';
import type { ReportInput, BackendEvent, DispatchInput } from '../../../packages/core/src/backend-model.js';
import { ApiError, boatName, capability, digest, dispatchInput, hex, identifier, object, reportInput, repoIdentity, requireThat, sameHash, text } from './protocol.js';
import { boatPermissions, permits, personPermissions, requiredPermission } from './permissions.js';
import type { Permission } from './permissions.js';

type Actor = { kind: 'person' | 'boat'; id: string; permissions: Permission[] } | { kind: 'dispatch'; id: string; epoch: number };
type DispatchRow = { id: string; data: string; state: string; worker: string | null; boat: string | null; epoch: number; lease: number; hash: string | null; nonce: string | null };
type BoatRow = { id: string; name: string; hash: string; revoked: number };
type WorkerRow = { id: string; boat: string; repo: string; seen: number };
type StoredResult = { status: number; value: unknown };
type FileRow = { id: string; dispatch: string; name: string; size: number; hash: string; ready: number };
export type Command = { account: string; helm: boolean; personId?: string; token: string; method: string; path: string; key?: string; session?: string; body: unknown; after?: string;
  prepared?: { id?: string; hash: string } };
const LEASE_MS = 90_000;
const HELM_MS = 120_000;

/** One account's only coordination authority. No alarms, timers or sockets. */
export class Account extends DurableObject<Env> {
  /** Serialises only R2 mutations in this live instance; ownership stays in SQL. */
  private fileTail: Promise<unknown> = Promise.resolve();
  /** Private binding only: the signed-in approval page chooses a visible name. */
  availableBoatName(requested: string, own?: string): string {
    const base = boatName(requested);
    const taken = (name: string) => this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM boats WHERE name=? COLLATE NOCASE', name).toArray().some((b) => b.id !== own);
    if (!taken(base)) return base;
    for (let n = 2; n <= Number(this.env.MAX_ROWS) + 2; n++) {
      const suffix = `-${n}`, candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
    throw new ApiError(409, 'no available boat name; choose another name');
  }
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
      CREATE UNIQUE INDEX IF NOT EXISTS boat_name ON boats(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS boat_permissions (boat TEXT PRIMARY KEY, permissions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, boat TEXT NOT NULL, repo TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS worker_repo ON workers(repo,seen);
      CREATE TABLE IF NOT EXISTS worker_nicknames (worker TEXT PRIMARY KEY, nickname TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unservable (dispatch TEXT PRIMARY KEY, repo TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, worker TEXT, boat TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0, hash TEXT, nonce TEXT);
      CREATE INDEX IF NOT EXISTS dispatch_worker ON dispatches(worker, state);
      CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dispatch TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_details (seq INTEGER PRIMARY KEY, note TEXT NOT NULL);
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
  private event(kind: string, dispatch?: string, note?: string) {
    this.ctx.storage.sql.exec('INSERT INTO events(kind,dispatch,at) VALUES (?,?,?)', kind, dispatch ?? null, new Date().toISOString());
    if (note) this.ctx.storage.sql.exec('INSERT INTO event_details VALUES (last_insert_rowid(),?)', note);
  }
  private targetBoat(d: DispatchInput): BoatRow | undefined {
    return d.boat ? this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', d.boat).toArray()[0] : undefined;
  }
  /** Polling is the guarantee: observe expiry on the next request, without timers. */
  private availability(now: number) {
    const absent = this.ctx.storage.sql.exec<DispatchRow>(`SELECT d.* FROM dispatches d WHERE d.state='queued' AND NOT EXISTS (
      SELECT 1 FROM workers w JOIN boats b ON b.id=w.boat LEFT JOIN boat_permissions p ON p.boat=b.id WHERE b.revoked=0 AND w.seen>?
      AND (p.boat IS NULL OR EXISTS (SELECT 1 FROM json_each(p.permissions) WHERE value='work'))
      AND w.repo=json_extract(d.data,'$.repoRemote') AND (json_extract(d.data,'$.for') IS NULL OR json_extract(d.data,'$.for')=w.id)
      AND (json_extract(d.data,'$.boat') IS NULL OR json_extract(d.data,'$.boat')=w.boat)
    )`, now - LEASE_MS).toArray();
    const ids = new Set(absent.map((d) => d.id));
    for (const row of this.ctx.storage.sql.exec<{ dispatch: string }>('SELECT dispatch FROM unservable').toArray()) {
      if (!ids.has(row.dispatch)) {
        this.ctx.storage.sql.exec('DELETE FROM unservable WHERE dispatch=?', row.dispatch);
        this.event('servable', row.dispatch);
      }
    }
    for (const d of absent) {
      const input = JSON.parse(d.data) as DispatchInput; const repo = input.repoRemote!;
      const target = this.targetBoat(input);
      const note = target ? `${repo}: boat ${target.name} has no eligible online worker${target.revoked ? ' (credential revoked)' : ''}` : `${repo}: no boat online has an eligible signed-on worker`;
      const previous = this.ctx.storage.sql.exec<{ note: string }>('SELECT note FROM unservable WHERE dispatch=?', d.id).toArray()[0];
      if (previous?.note !== note) {
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO unservable VALUES (?,?,?)', d.id, repo, note);
        this.event('unservable', d.id, note);
      }
    }
  }
  private view(d: DispatchRow) {
    const input = JSON.parse(d.data) as DispatchInput; const target = this.targetBoat(input);
    const unservable = this.ctx.storage.sql.exec<{ repo: string; note: string }>('SELECT repo,note FROM unservable WHERE dispatch=?', d.id).toArray()[0];
    return { ...input, state: d.state, status: this.lastReport(d.id), ...(target ? { boatName: target.name } : {}), ...(unservable ? { unservable } : {}) };
  }
  private authenticate(c: Command, hash: string, now: number): Actor {
    if (c.helm) return { kind: 'person', id: c.personId ?? 'person', permissions: personPermissions };
    const pieces = c.token.split('.'); requireThat(pieces[1] === c.account, 403, 'wrong account');
    if (pieces[0] === 'b') {
      const m = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', pieces[2]).toArray()[0];
      requireThat(m && !m.revoked && sameHash(hash, m.hash), 401, 'invalid boat credential');
      const row = this.ctx.storage.sql.exec<{ permissions: string }>('SELECT permissions FROM boat_permissions WHERE boat=?', m.id).toArray()[0];
      return { kind: 'boat', id: m.id, permissions: row ? JSON.parse(row.permissions) : ['work'] };
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
  private boatCanWork(id: string | null): boolean {
    if (!id) return false;
    const row = this.ctx.storage.sql.exec<{ revoked: number; permissions: string }>("SELECT b.revoked,coalesce(p.permissions,'[\"work\"]') AS permissions FROM boats b LEFT JOIN boat_permissions p ON p.boat=b.id WHERE b.id=?", id).toArray()[0];
    return !!row && !row.revoked && JSON.parse(row.permissions).includes('work');
  }
  private helm(c: Command, actor: Actor, now: number) {
    this.requirePermission(actor, 'helm');
    const seat = this.get('helm'); const h = seat ? JSON.parse(seat) : undefined;
    requireThat(h && h.session === c.session && h.actor === `${actor.kind}:${actor.id}` && h.until > now, 409, 'take or renew the helm lease first');
  }
  private requirePermission(actor: Actor, permission: Permission) {
    requireThat(actor.kind !== 'dispatch' && permits(actor.permissions, permission), 403, `${permission} permission required`);
    if (permission === 'work') requireThat(actor.kind === 'boat', 403, 'enrol this machine as a boat with lobstah wharf login before signing on or claiming work');
  }
  private authorize(c: Command, actor: Actor) {
    // Person sessions never fish, even if a caller retries a prior request.
    const permission = requiredPermission(c.path, c.method);
    if (permission === 'work' && actor.kind === 'person') throw new ApiError(403, 'enrol this machine as a boat with lobstah wharf login before signing on or claiming work');
    if (actor.kind !== 'dispatch' && permission) this.requirePermission(actor, permission);
    if (actor.kind === 'dispatch') requireThat(c.path.startsWith(`dispatches/${actor.id}/`) || c.path === `dispatches/${actor.id}`, 403, 'dispatch scope required');
  }
  private budget(now: number) {
    const window = Math.floor(now / 60000); const b = JSON.parse(this.get('budget') ?? '{"window":0,"count":0}');
    if (b.window !== window) { b.window = window; b.count = 0; }
    requireThat(b.count < Number(this.env.REQUESTS_PER_MINUTE), 429, 'account rate limit');
    b.count++; this.set('budget', JSON.stringify(b));
  }
  private capacity() {
    const tables = ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files'];
    const count = tables.reduce((n, t) => n + this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n, 0);
    requireThat(count < Number(this.env.MAX_ROWS) && this.ctx.storage.sql.databaseSize < Number(this.env.MAX_ACCOUNT_BYTES), 507, 'account storage limit');
  }
  async command(c: Command): Promise<StoredResult> {
    const hash = await digest(c.token.startsWith('d.') || c.token.startsWith('b.') ? c.token.split('.').at(-1)! : c.token);
    const fingerprint = await digest(JSON.stringify([c.method, c.path, c.body, c.session]));
    // Crypto awaits are before the transaction. Auth and ownership are checked
    // inside it, including revocations that arrived while hashing.
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      requireThat(!this.get('deleted'), 410, 'account deleted');
      const actor = this.authenticate(c, hash, now); this.budget(now); this.expire(now);
      this.authorize(c, actor);
      if (c.method !== 'GET') {
        requireThat(c.key && /^[A-Za-z0-9_-]{1,128}$/.test(c.key), 400, 'Idempotency-Key required');
        const previous = this.ctx.storage.sql.exec<{ fingerprint: string; result: string }>('SELECT * FROM idem WHERE actor=? AND key=?', `${actor.kind}:${actor.id}`, c.key).toArray()[0];
        if (previous) { requireThat(previous.fingerprint === fingerprint, 409, 'idempotency key reused with different request'); return JSON.parse(previous.result); }
        this.capacity();
      }
      this.availability(now);
      const result = this.execute(c, actor, now);
      this.availability(now);
      if (c.method !== 'GET') this.ctx.storage.sql.exec('INSERT INTO idem VALUES (?,?,?,?)', `${actor.kind}:${actor.id}`, c.key!, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  private execute(c: Command, actor: Actor, now: number): StoredResult {
    const ok = (value: unknown = {}): StoredResult => ({ status: 200, value });
    const b = c.method === 'GET' ? {} : object(c.body);
    if (c.path === '_boat' && c.method === 'GET') {
      requireThat(actor.kind === 'boat', 403, 'boat credential required');
      const boat = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', actor.id).one();
      return ok({ id: boat.id, name: boat.name, permissions: actor.permissions });
    }
    if (c.path === '_issue' && c.method === 'POST') {
      this.requirePermission(actor, 'admin'); requireThat(c.prepared?.id, 403, 'prepared credential required');
      const name = boatName(b.name);
      const selected = boatPermissions(b.permissions, b.confirmAdmin);
      const named = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE name=? COLLATE NOCASE', name).toArray()[0];
      const previous = b.enrol && b.expectedBoat ? this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', identifier(b.expectedBoat)).toArray()[0] : named;
      if (b.enrol) {
        requireThat(!named || named.id === b.expectedBoat, 409, 'boat name already enrolled; choose another name');
        requireThat(b.expectedBoat ? previous && !previous.revoked && typeof b.proof === 'string' && sameHash(previous.hash, b.proof) : !previous, 409, 'prove the current boat credential or choose another name');
      }
      const id = previous?.id ?? c.prepared.id;
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO boats(id,name,hash,revoked) VALUES (?,?,?,0)', id, name, c.prepared.hash);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO boat_permissions VALUES (?,?)', id, JSON.stringify(selected));
      this.event(previous ? 'boat-credential-rotated' : 'boat-issued', undefined, `boat: ${name}`);
      return { status: 201, value: { id, name, permissions: selected, issuance: c.prepared.id } };
    }
    if (c.path === '_claim' && c.method === 'POST') {
      requireThat(actor.kind === 'boat' && c.prepared, 403, 'boat scope required');
      requireThat(b.boat === undefined, 400, 'boat credentials cannot select another boat');
      const w = this.worker(b.worker, actor.id);
      requireThat(w.seen + LEASE_MS > now, 409, 'worker sign-on expired; renew first');
      requireThat(!this.ctx.storage.sql.exec("SELECT id FROM dispatches WHERE worker=? AND state='active'", w.id).toArray().length, 409, 'worker already has an open catch');
      // Addressed work remains sticky, including absent/stale workers.
      const d = this.ctx.storage.sql.exec<DispatchRow>(`SELECT * FROM dispatches WHERE state='queued'
        AND json_extract(data,'$.repoRemote')=? AND (json_extract(data,'$.for')=? OR json_extract(data,'$.for') IS NULL)
        AND (json_extract(data,'$.boat') IS NULL OR json_extract(data,'$.boat')=?)
        ORDER BY CASE WHEN json_extract(data,'$.for')=? THEN 0 ELSE 1 END, rowid LIMIT 1`, w.repo, w.id, actor.id, w.id).toArray()[0];
      if (!d) return ok(null);
      const epoch = d.epoch + 1;
      this.ctx.storage.sql.exec("UPDATE dispatches SET state='active',worker=?,boat=?,epoch=?,lease=?,hash=? WHERE id=?", w.id, actor.id, epoch, now + LEASE_MS, c.prepared.hash, d.id);
      this.ctx.storage.sql.exec('INSERT INTO claims VALUES (?,?,?)', d.id, epoch, c.prepared.hash);
      this.event('claimed', d.id);
      return ok({ id: d.id, dispatch: JSON.parse(d.data), epoch, leaseUntil: new Date(now + LEASE_MS).toISOString() });
    }
    if (c.path === 'helm/take' && c.method === 'POST') {
      this.requirePermission(actor, 'helm'); const session = identifier(b.session);
      const previous = JSON.parse(this.get('helm') ?? 'null');
      const principal = `${actor.kind}:${actor.id}`;
      requireThat(!previous || previous.session === session && previous.actor === principal || previous.until <= now || b.take === true, 409, 'helm held; explicit takeover required');
      const h = { session, actor: principal, until: now + HELM_MS }; this.set('helm', JSON.stringify(h)); this.event('helm-taken'); return ok(h);
    }
    if (c.path === 'helm/renew' || c.path === 'helm/release') {
      requireThat(c.method === 'POST', 405, 'POST required'); this.helm(c, actor, now);
      const h = { session: c.session, actor: `${actor.kind}:${actor.id}`, until: c.path.endsWith('release') ? 0 : now + HELM_MS };
      this.set('helm', JSON.stringify(h)); return ok(h);
    }
    if (c.path === 'boats' && c.method === 'GET') {
      this.requirePermission(actor, 'read');
      return ok(this.ctx.storage.sql.exec<{ id: string; name: string; revoked: number; permissions: string }>("SELECT b.id,b.name,b.revoked,coalesce(p.permissions,'[\"work\"]') AS permissions FROM boats b LEFT JOIN boat_permissions p ON p.boat=b.id").toArray().map((b) => ({ ...b, permissions: JSON.parse(b.permissions) })));
    }
    if (c.path.startsWith('boats/') && c.path.endsWith('/revoke') && c.method === 'POST') {
      this.requirePermission(actor, 'admin');
      const id = identifier(c.path.split('/')[1]); const target = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', id).toArray()[0];
      requireThat(target, 404, 'boat not found');
      this.ctx.storage.sql.exec('UPDATE boats SET revoked=1 WHERE id=?', id); this.event('boat-revoked', undefined, `boat: ${target.name}`); return ok();
    }
    if (c.path === 'workers/sign-on' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required');
      requireThat(b.boat === undefined, 400, 'boat credentials cannot select another boat');
      const id = identifier(b.worker); const repo = repoIdentity(b.repoRemote); const nickname = identifier(b.repo);
      const old = this.ctx.storage.sql.exec<WorkerRow>('SELECT * FROM workers WHERE id=?', id).toArray()[0];
      requireThat(!old || old.boat === actor.id, 409, 'worker belongs to another boat');
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO workers VALUES (?,?,?,?)', id, actor.id, repo, now);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO worker_nicknames VALUES (?,?)', id, nickname);
      this.event('worker-signed-on'); return ok({ id, repo: nickname, repoRemote: repo });
    }
    if (c.path === 'workers/renew' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required'); const w = this.worker(b.worker, actor.id);
      requireThat(b.boat === undefined, 400, 'boat credentials cannot select another boat');
      this.ctx.storage.sql.exec('UPDATE workers SET seen=? WHERE id=?', now, w.id);
      this.ctx.storage.sql.exec("UPDATE dispatches SET lease=? WHERE worker=? AND boat=? AND state='active'", now + LEASE_MS, w.id, actor.id);
      return ok();
    }
    if (c.path === 'dispatches' && c.method === 'POST') {
      this.helm(c, actor, now); const d = dispatchInput(b);
      if (d.boat) requireThat(this.targetBoat(d), 404, 'target boat not found');
      requireThat(!this.ctx.storage.sql.exec('SELECT id FROM dispatches WHERE id=?', d.id).toArray().length, 409, 'dispatch already exists');
      if (d.followUp) this.dispatch(d.followUp);
      this.ctx.storage.sql.exec("INSERT INTO dispatches(id,data,state) VALUES (?,?,'queued')", d.id, JSON.stringify(d)); this.event('queued', d.id); return ok(d);
    }
    if (c.path === 'dispatches' && c.method === 'GET') {
      this.requirePermission(actor, 'read');
      return ok(this.ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches ORDER BY rowid DESC LIMIT 100').toArray().map((d) => this.view(d)));
    }
    if (c.path === 'events' && c.method === 'GET') {
      this.requirePermission(actor, 'read');
      const generation = this.get('generation')!; const [g, n] = (c.after ?? `${generation}.0`).split('.');
      requireThat(g === generation && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)), 400, 'invalid account event cursor');
      const rows = this.ctx.storage.sql.exec<{ seq: number; kind: string; dispatch: string | null; at: string; note: string | null }>('SELECT e.*,d.note FROM events e LEFT JOIN event_details d ON d.seq=e.seq WHERE e.seq>? ORDER BY e.seq LIMIT 100', Number(n)).toArray();
      const events: BackendEvent[] = rows.map((r) => ({ cursor: `${generation}.${r.seq}`, kind: r.kind, ...(r.dispatch ? { dispatchId: r.dispatch } : {}), at: r.at, ...(r.note ? { note: r.note } : {}) }));
      // Historical events still label an addressed boat with its current name.
      for (const e of events) if (e.dispatchId) {
        const d = this.ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches WHERE id=?', e.dispatchId).toArray()[0];
        const target = d ? this.targetBoat(JSON.parse(d.data)) : undefined;
        if (target) {
          e.boatName = target.name;
          if (e.note) e.note = e.note.replace(/boat [a-z0-9_-]+/g, `boat ${target.name}`);
        }
      }
      return ok({ events, cursor: events.at(-1)?.cursor ?? `${generation}.${n}` });
    }
    const parts = c.path.split('/');
    if (parts[0] === 'dispatches' && parts[1]) {
      const d = this.dispatch(identifier(parts[1])); const action = parts[2];
      requireThat(actor.kind !== 'dispatch' || actor.id === d.id, 403, 'dispatch scope required');
      if (!action && c.method === 'GET') return ok(this.view(d));
      if (action === 'cancel' && c.method === 'POST') {
        this.helm(c, actor, now); this.ctx.storage.sql.exec("UPDATE dispatches SET state='cancelled',hash=NULL WHERE id=?", d.id); this.event('cancelled', d.id); return ok();
      }
      if (action === 'heartbeat' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required');
        requireThat(d.state === 'active', 409, 'dispatch no longer active');
        requireThat(this.boatCanWork(d.boat), 403, 'boat revoked or work permission removed; lease cannot be extended');
        this.ctx.storage.sql.exec('UPDATE dispatches SET lease=? WHERE id=?', now + LEASE_MS, d.id); return ok({ leaseUntil: new Date(now + LEASE_MS).toISOString() });
      }
      if (action === 'report' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required'); const report = reportInput(b);
        requireThat(d.state === 'active', 409, 'dispatch no longer active');
        if (report.verb === 'done') requireThat(!this.ctx.storage.sql.exec('SELECT id FROM messages WHERE dispatch=? AND received=0', d.id).toArray().length, 409, 'unreceived messages; read and receipt before done');
        for (const file of report.evidence?.files ?? []) requireThat(this.ctx.storage.sql.exec('SELECT id FROM files WHERE id=? AND dispatch=? AND ready=1', file, d.id).toArray().length, 400, 'evidence file not uploaded to this dispatch');
        if (report.verb === 'paused' && !report.until) report.until = new Date(now + 86400_000).toISOString();
        this.ctx.storage.sql.exec('INSERT INTO reports(dispatch,data) VALUES (?,?)', d.id, JSON.stringify({ ...report, at: new Date(now).toISOString() }));
        this.ctx.storage.sql.exec('UPDATE dispatches SET state=?,lease=? WHERE id=?', ['done', 'failed'].includes(report.verb) ? 'done' : 'active', this.boatCanWork(d.boat) ? now + LEASE_MS : d.lease, d.id);
        this.event(report.verb, d.id); return ok();
      }
      if (action === 'recovery' && c.method === 'POST') {
        requireThat(actor.kind === 'dispatch', 403, 'dispatch scope required');
        const report = reportInput(b); const id = crypto.randomUUID();
        this.ctx.storage.sql.exec('INSERT INTO recoveries VALUES (?,?,?,?)', id, d.id, actor.epoch, JSON.stringify(report));
        this.event('recovery-submitted', d.id); return ok({ id, finalised: false });
      }
      if (action === 'recoveries' && c.method === 'GET') {
        this.requirePermission(actor, 'read');
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
    const b = object(c.body); const name = boatName(b.name); const id = crypto.randomUUID();
    const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`; const hash = await digest(secret);
    const base = await this.command({ ...c, path: '_issue', body: { ...b, name }, prepared: { id, hash } });
    if (base.status !== 201) return base;
    const { issuance, ...value } = object(base.value);
    const token = `b.${c.account}.${value.id}.${secret}`;
    return { ...base, value: { ...value, ...(issuance === id ? { token } : {}) } };
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
        const hash = await digest(c.token.startsWith('b.') ? c.token.split('.').at(-1)! : c.token);
        requireThat(c.key && /^[A-Za-z0-9_-]{1,128}$/.test(c.key), 400, 'Idempotency-Key required');
        const keyHash = await digest(c.key);
        const prior = this.get('deleted'); requireThat(!prior || prior === keyHash, 410, 'account deleted');
        if (prior) requireThat(sameHash(this.get('delete-authority') ?? '', hash), 403, 'deletion retry belongs to another credential');
        else this.requirePermission(this.authenticate(c, hash, Date.now()), 'admin');
        this.set('delete-authority', hash); // permits the same admin retry after its boat row is deleted
        this.set('deleted', keyHash); // reject every other request before R2 I/O
        for (;;) {
          const files = await this.env.FILES.list({ prefix: `${c.account}/`, limit: 1000 });
          if (!files.objects.length) break;
          await this.env.FILES.delete(files.objects.map((f) => f.key));
        }
        this.ctx.storage.transactionSync(() => {
          for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files']) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
          this.ctx.storage.sql.exec("DELETE FROM meta WHERE key NOT IN ('deleted','delete-authority')");
        });
        // Keep only a tombstone; the Worker also removes this person's D1 identity.
        return JSON.stringify({ status: 200, value: { deleted: true } });
      } catch (e) {
        if (e instanceof ApiError) return JSON.stringify({ status: e.status, value: { error: e.message } });
        throw e;
      }
    });
  }
}
