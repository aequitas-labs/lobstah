import { MIRROR_ATTENTION_MAX_BYTES, MIRROR_ATTENTION_MAX_ITEMS, MIRROR_CALL_MS, mirrorReadAllowed, mirrorWriteAllowed } from '../../../packages/core/src/backend-model.js';
import type { WharfMirrorCall, WharfMirrorCallInput, WharfMirrorSnapshot } from '../../../packages/core/src/backend-model.js';
import { identifier, object, requireThat, text } from './protocol.js';
import type { Actor, Command } from './account.js';

/**
 * A mirror boat's state on the wharf: its latest glass snapshot (the bytes
 * live in R2, one object per boat, overwritten by each put) and the calls
 * the hosted glass relays to it. Nothing here is a record of the fleet: the
 * boat stays the authority, and the wharf keeps a copy and calls in transit.
 */
export const mirrorSchema = `
  CREATE TABLE IF NOT EXISTS mirror_snapshots (boat TEXT PRIMARY KEY, etag TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mirror_calls (id TEXT PRIMARY KEY, boat TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS mirror_call_boat ON mirror_calls(boat);
  CREATE TABLE IF NOT EXISTS mirror_files (id TEXT PRIMARY KEY, boat TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS mirror_attention (boat TEXT PRIMARY KEY, etag TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
`;
export const mirrorTables = ['mirror_snapshots', 'mirror_calls', 'mirror_files', 'mirror_attention'];

/**
 * A boat's walking list as it puts it, checked and serialized once: a JSON
 * array of items, at most MIRROR_ATTENTION_MAX_ITEMS of them and
 * MIRROR_ATTENTION_MAX_BYTES in all. The wharf never reads inside an item.
 */
export function attentionJson(body: unknown): string {
  const b = object(body);
  requireThat(Object.keys(b).every((k) => k === 'attention'), 400, 'unexpected field');
  const list = b.attention;
  requireThat(Array.isArray(list) && list.length <= MIRROR_ATTENTION_MAX_ITEMS && list.every((i) => i !== null && typeof i === 'object' && !Array.isArray(i)),
    400, `attention must be a list of at most ${MIRROR_ATTENTION_MAX_ITEMS} items`);
  const json = JSON.stringify(list);
  requireThat(json.length <= MIRROR_ATTENTION_MAX_BYTES, 413, 'attention list too large');
  return json;
}
/** How long a browser's read of the mirror list counts as a hosted glass being open. */
export const MIRROR_WATCH_MS = 30_000;
/** The most calls a boat may have waiting, and the most a list returns. */
const MIRROR_CALL_LIMIT = 32;

/** The R2 key of a boat's latest snapshot. */
export const mirrorSnapshotKey = (account: string, boat: string): string => `${account}/mirror/snapshots/${boat}`;
/** The R2 key of a relayed call's answer body. */
export const mirrorAnswerKey = (account: string, call: string): string => `${account}/mirror/answers/${call}`;
/** The R2 key of a file the hosted glass uploaded for a relayed answer. */
export const mirrorFileKey = (account: string, file: string): string => `${account}/mirror/files/${file}`;

/** One mirror boat as the hosted glass lists it, with where its snapshot's bytes are. */
export type MirrorListing = WharfMirrorSnapshot & { key: string };
/** A call's answer as the boat sends it. */
export type MirrorAnswerInput = { status: number; contentType: string; bytes: number };
/** What a mirror operation leaves for R2 once its transaction commits. */
export type MirrorCleanup = { keys: string[] };
type Result = { status: number; value: unknown };
type Hooks = { read: (actor: Actor) => void; mirror: (actor: Actor) => void };

/** Pure synchronous SQL operations inside the account's auth transaction. */
export class MirrorState {
  constructor(private sql: SqlStorage, private hooks: Hooks) {}
  private call(id: string): WharfMirrorCall {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM mirror_calls WHERE id=?', identifier(id)).toArray()[0];
    requireThat(row, 404, 'call not found');
    return JSON.parse(row.data) as WharfMirrorCall;
  }
  private save(call: WharfMirrorCall) {
    this.sql.exec('INSERT OR REPLACE INTO mirror_calls VALUES (?,?,?)', call.id, call.boat, JSON.stringify(call));
  }
  private person(actor: Actor) { requireThat(actor.kind === 'person', 403, 'signed-in person required'); }
  private boat(actor: Actor): string {
    this.hooks.mirror(actor);
    requireThat(actor.kind === 'boat', 403, 'mirror boat credential required');
    return actor.id;
  }
  /** Whether a boat may mirror now: enrolled, not revoked, and granted `mirror`. */
  private mirrorBoat(id: string): boolean {
    return this.sql.exec<{ id: string }>(`SELECT b.id FROM boats b JOIN boat_permissions p ON p.boat=b.id
      WHERE b.id=? AND b.revoked=0 AND EXISTS (SELECT 1 FROM json_each(p.permissions) WHERE value='mirror')`, id).toArray().length > 0;
  }
  /**
   * Expire calls past their time and files nobody fetched, and return the
   * R2 keys they leave behind. An expired call stays listed, so its page
   * learns it expired, until its own time plus another wait has passed.
   */
  /** When the next live call passes its time and turns expired, so its page learns it without polling; none when no call is live. */
  nextExpiry(now: number): number | undefined {
    let next: number | undefined;
    for (const row of this.sql.exec<{ data: string }>('SELECT data FROM mirror_calls').toArray()) {
      const call = JSON.parse(row.data) as WharfMirrorCall;
      const ends = Date.parse(call.expiresAt);
      if (call.state !== 'answered' && call.state !== 'expired' && ends > now) next = Math.min(next ?? ends, ends);
    }
    return next;
  }
  expire(account: string, now: number): MirrorCleanup {
    const keys: string[] = [];
    for (const row of this.sql.exec<{ id: string; data: string }>('SELECT id,data FROM mirror_calls').toArray()) {
      const call = JSON.parse(row.data) as WharfMirrorCall;
      const ends = Date.parse(call.expiresAt);
      if (ends + MIRROR_CALL_MS <= now) {
        this.sql.exec('DELETE FROM mirror_calls WHERE id=?', call.id);
        if (call.answer) keys.push(mirrorAnswerKey(account, call.id));
      } else if (ends <= now && call.state !== 'answered' && call.state !== 'expired') {
        call.state = 'expired'; this.save(call);
      }
    }
    for (const row of this.sql.exec<{ id: string }>('SELECT id FROM mirror_files WHERE expires<=?', now).toArray()) {
      this.sql.exec('DELETE FROM mirror_files WHERE id=?', row.id);
      keys.push(mirrorFileKey(account, row.id));
    }
    return { keys };
  }
  /** A revoked boat mirrors nothing: its snapshot and calls go with it. */
  forget(account: string, boat: string): MirrorCleanup {
    const keys = [mirrorSnapshotKey(account, boat)];
    for (const row of this.sql.exec<{ id: string; data: string }>('SELECT id,data FROM mirror_calls WHERE boat=?', boat).toArray()) {
      if ((JSON.parse(row.data) as WharfMirrorCall).answer) keys.push(mirrorAnswerKey(account, row.id));
    }
    for (const row of this.sql.exec<{ id: string }>('SELECT id FROM mirror_files WHERE boat=?', boat).toArray()) keys.push(mirrorFileKey(account, row.id));
    this.sql.exec('DELETE FROM mirror_snapshots WHERE boat=?', boat);
    this.sql.exec('DELETE FROM mirror_calls WHERE boat=?', boat);
    this.sql.exec('DELETE FROM mirror_files WHERE boat=?', boat);
    this.sql.exec('DELETE FROM mirror_attention WHERE boat=?', boat);
    return { keys };
  }
  /** The boat's put, after its bytes are in R2: the new ETag and size, and when. */
  recordSnapshot(actor: Actor, etag: string, bytes: number, now: number): Result {
    const boat = this.boat(actor);
    requireThat(/^[a-f0-9]{64}$/.test(etag), 400, 'invalid snapshot digest');
    const at = new Date(now).toISOString();
    this.sql.exec('INSERT OR REPLACE INTO mirror_snapshots VALUES (?,?,?,?)', boat, etag, bytes, at);
    return { status: 200, value: { etag, bytes, at } };
  }
  /**
   * A boat's put of its walking list (`json` from attentionJson, `etag` its
   * digest). An unchanged list keeps its time and says so: the wharf hints
   * the other boats only when `changed`.
   */
  putAttention(actor: Actor, json: string, etag: string, now: number): Result & { changed: boolean } {
    const boat = this.boat(actor);
    const prior = this.sql.exec<{ etag: string; at: string }>('SELECT etag,at FROM mirror_attention WHERE boat=?', boat).toArray()[0];
    if (prior?.etag === etag) return { status: 200, value: { etag, at: prior.at, changed: false }, changed: false };
    const at = new Date(now).toISOString();
    this.sql.exec('INSERT OR REPLACE INTO mirror_attention VALUES (?,?,?,?)', boat, etag, at, json);
    return { status: 200, value: { etag, at, changed: true }, changed: true };
  }
  /** Before a put: the boat may mirror. */
  authorizeSnapshot(actor: Actor): void { this.boat(actor); }
  /** Before an answer is stored: the call is this boat's, taken, and not expired. */
  authorizeAnswer(actor: Actor, id: string, now: number): void {
    const boat = this.boat(actor), call = this.call(id);
    requireThat(call.boat === boat, 403, 'addressed boat required');
    requireThat(call.state === 'taken' && Date.parse(call.expiresAt) > now, 409, 'take a live call before answering it');
  }
  /** After an answer's body is in R2: the call is answered. */
  recordAnswer(actor: Actor, id: string, answer: MirrorAnswerInput, now: number): Result {
    this.authorizeAnswer(actor, id, now);
    const call = this.call(id);
    call.state = 'answered'; call.answer = { ...answer, at: new Date(now).toISOString() };
    this.save(call);
    return { status: 200, value: call };
  }
  /** Before a file is stored: a signed-in person, for a mirror boat. */
  authorizeFile(actor: Actor, boat: string): void {
    this.person(actor);
    requireThat(this.mirrorBoat(identifier(boat)), 404, 'mirror boat not found');
  }
  /** After a file's bytes are in R2: it waits for the call that names it, for one call's time. */
  recordFile(actor: Actor, boat: string, id: string, name: string, size: number, now: number): Result {
    this.authorizeFile(actor, boat);
    this.sql.exec('INSERT INTO mirror_files VALUES (?,?,?,?,?)', id, boat, name, size, now + MIRROR_CALL_MS);
    return { status: 200, value: { id, name, size } };
  }
  /**
   * The routes in this transaction. `watch` is set when a person reads the
   * mirror list: the boats are told a hosted glass is open.
   */
  execute(c: Command, actor: Actor, now: number, account: string): Result & { watch?: boolean; hint?: string } {
    const parts = c.path.split('/');
    const ok = (value: unknown = {}) => ({ status: 200, value });
    // The hosted glass's list: every mirror boat's latest snapshot, with its name, time and ETag.
    if (c.path === 'mirror' && c.method === 'GET') {
      this.person(actor);
      const boats = this.sql.exec<{ boat: string; name: string; at: string; etag: string; bytes: number }>(`SELECT s.boat,b.name,s.at,s.etag,s.bytes FROM mirror_snapshots s JOIN boats b ON b.id=s.boat
        JOIN boat_permissions p ON p.boat=b.id WHERE b.revoked=0 AND EXISTS (SELECT 1 FROM json_each(p.permissions) WHERE value='mirror') ORDER BY b.name LIMIT 100`).toArray()
        .map((s): MirrorListing => ({ boat: s.boat, name: s.name, at: s.at, etag: s.etag, bytes: s.bytes, key: mirrorSnapshotKey(account, s.boat) }));
      return { ...ok({ boats }), watch: true };
    }
    // Every other mirror boat's walking list, for a boat granted attention (permissions.ts checks the grant).
    if (c.path === 'mirror/attention' && c.method === 'GET') {
      const boat = this.boat(actor);
      const boats = this.sql.exec<{ boat: string; name: string; at: string; etag: string; data: string }>(`SELECT a.boat,b.name,a.at,a.etag,a.data FROM mirror_attention a JOIN boats b ON b.id=a.boat
        JOIN boat_permissions p ON p.boat=b.id WHERE b.revoked=0 AND a.boat<>? AND EXISTS (SELECT 1 FROM json_each(p.permissions) WHERE value='mirror') ORDER BY b.name LIMIT 100`, boat).toArray()
        .map((r) => ({ boat: r.boat, name: r.name, at: r.at, etag: r.etag, attention: JSON.parse(r.data) as unknown[] }));
      return ok({ boats });
    }
    // Ask the boat that owns an item to acknowledge it: one relayed attention-ack call, as a hosted glass click makes.
    if (c.path === 'mirror/attention/acks' && c.method === 'POST') {
      const from = this.boat(actor);
      const b = object(c.body);
      requireThat(Object.keys(b).every((k) => ['boat', 'key', 'stateHash'].includes(k)), 400, 'unexpected field');
      const boat = identifier(b.boat), key = text(b.key, 300), stateHash = text(b.stateHash, 200);
      requireThat(boat !== from, 400, "acknowledge this boat's own items on this boat");
      requireThat(this.mirrorBoat(boat), 404, 'mirror boat not found');
      const waiting = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM mirror_calls WHERE boat=? AND json_extract(data,'$.state') IN ('queued','taken')", boat).one().n;
      requireThat(waiting < MIRROR_CALL_LIMIT, 429, 'too many calls waiting for this boat');
      const stored: WharfMirrorCall = { id: crypto.randomUUID(), boat, write: { kind: 'attention-ack', payload: { items: [{ key, stateHash }] } },
        at: new Date(now).toISOString(), expiresAt: new Date(now + MIRROR_CALL_MS).toISOString(), state: 'queued', by: from };
      this.save(stored);
      return { ...ok({ id: stored.id, boat }), hint: boat };
    }
    if (parts[0] === 'mirror' && parts[1] === 'calls') {
      if (parts.length === 2 && c.method === 'POST') {
        this.person(actor);
        const call = this.callInput(c.body);
        requireThat(this.mirrorBoat(call.boat), 404, 'mirror boat not found');
        requireThat(!this.sql.exec('SELECT id FROM mirror_calls WHERE id=?', call.id).toArray().length, 409, 'call already exists');
        const waiting = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM mirror_calls WHERE boat=? AND json_extract(data,'$.state') IN ('queued','taken')", call.boat).one().n;
        requireThat(waiting < MIRROR_CALL_LIMIT, 429, 'too many calls waiting for this boat');
        for (const file of call.files ?? []) {
          requireThat(this.sql.exec('SELECT id FROM mirror_files WHERE id=? AND boat=?', file, call.boat).toArray().length, 400, 'file was not uploaded for this boat');
        }
        const stored: WharfMirrorCall = { ...call, at: new Date(now).toISOString(), expiresAt: new Date(now + MIRROR_CALL_MS).toISOString(), state: 'queued', by: actor.id };
        this.save(stored);
        return { ...ok(stored), hint: call.boat };
      }
      if (parts.length === 2 && c.method === 'GET') {
        const boat = this.boat(actor);
        const calls = this.sql.exec<{ data: string }>(`SELECT data FROM mirror_calls WHERE boat=? AND json_extract(data,'$.state')='queued' ORDER BY rowid LIMIT ${MIRROR_CALL_LIMIT}`, boat).toArray()
          .map((r) => JSON.parse(r.data) as WharfMirrorCall);
        return ok({ calls });
      }
      const call = this.call(parts[2]!);
      if (parts.length === 3 && c.method === 'GET') {
        this.person(actor);
        return ok(call);
      }
      if (parts.length === 4 && parts[3] === 'take' && c.method === 'POST') {
        const boat = this.boat(actor);
        requireThat(call.boat === boat, 403, 'addressed boat required');
        requireThat(call.state !== 'expired' && Date.parse(call.expiresAt) > now, 410, 'call expired');
        requireThat(call.state === 'queued', 409, 'call already taken');
        call.state = 'taken'; this.save(call);
        return ok(call);
      }
    }
    if (parts[0] === 'mirror' && parts[1] === 'files' && parts.length === 3 && c.method === 'GET') {
      const boat = this.boat(actor), id = identifier(parts[2]);
      const file = this.sql.exec<{ id: string; name: string; size: number }>('SELECT id,name,size FROM mirror_files WHERE id=? AND boat=? AND expires>?', id, boat, now).toArray()[0];
      requireThat(file, 404, 'file not found');
      return ok({ ...file, key: mirrorFileKey(account, file.id) });
    }
    return { status: 404, value: { error: 'mirror route not found' } };
  }
  /** A relayed call as the hosted glass posts it: one allowed read, or one allowed write. */
  private callInput(value: unknown): WharfMirrorCallInput {
    const b = object(value);
    requireThat(Object.keys(b).every((k) => ['id', 'boat', 'read', 'write', 'files'].includes(k)), 400, 'unexpected field');
    const id = identifier(b.id), boat = identifier(b.boat);
    const files = b.files === undefined ? undefined : (() => {
      requireThat(Array.isArray(b.files) && b.files.length <= 8 && new Set(b.files).size === b.files.length, 400, 'at most 8 distinct files');
      return (b.files as unknown[]).map(identifier);
    })();
    requireThat((b.read === undefined) !== (b.write === undefined), 400, 'a call is one read or one write');
    if (b.read !== undefined) {
      const read = text(b.read, 700);
      requireThat(mirrorReadAllowed(read), 403, 'the hosted glass may not read that');
      requireThat(!files, 400, 'a read carries no files');
      return { id, boat, read };
    }
    const write = object(b.write);
    requireThat(Object.keys(write).every((k) => k === 'kind' || k === 'payload'), 400, 'unexpected field');
    requireThat(mirrorWriteAllowed(write.kind), 403, 'the hosted glass may not send that');
    requireThat(JSON.stringify(write.payload ?? null).length <= 60_000, 413, 'payload too large');
    return { id, boat, write: { kind: write.kind, payload: write.payload ?? null }, ...(files ? { files } : {}) };
  }
}
