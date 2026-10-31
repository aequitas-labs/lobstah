import { WHARF_REVIEW_REQUEST_KINDS } from '../../../packages/core/src/backend-model.js';
import type { WharfAck, WharfDocument, WharfDocumentInput, WharfFile, WharfHumanRequest, WharfReviewMeta } from '../../../packages/core/src/backend-model.js';
import { identifier, object, repoIdentity, requireThat, text } from './protocol.js';
import { cardSchema, cardTables } from './cards.js';
import { slackSchema, slackTables } from './slack-outbox.js';
import type { Actor, Command } from './account.js';
import type { SlackMessageIn } from './slack-ingress.js';

/** A person's request for work waits this long for the helm: a sleeping boat can still take it. */
export const WORK_REQUEST_MS = 7 * 86400_000;

export const glassSchema = `
  CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS human_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worker_details (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dispatch_acks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  ${cardSchema}
  ${slackSchema}
`;
export const glassTables = ['documents', 'human_requests', 'worker_details', 'dispatch_acks', ...cardTables, ...slackTables];
type Result = { status: number; value: unknown };
type Hooks = { helm: (c: Command, actor: Actor, now: number) => void; read: (actor: Actor) => void; work: (actor: Actor) => void; helmLive: (now: number) => boolean; event: (kind: string, dispatch?: string, note?: string) => void };
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
  /**
   * Who may author a document. A decision or report is the helm's: it needs
   * the leased seat. A review is the boat's that found the request: a boat
   * with work writes its own reviews with no helm, and no one else's.
   */
  private author(c: Command, actor: Actor, now: number, kind: unknown, d?: WharfDocument) {
    if (kind !== 'review') return this.hooks.helm(c, actor, now);
    this.hooks.work(actor);
    requireThat(!d || d.author === `${actor.kind}:${actor.id}`, 403, 'only the boat that published a review may change it');
  }
  private reviewMeta(value: unknown): WharfReviewMeta {
    const m = object(value), pr = text(m.pr, 300);
    requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(pr), 400, 'review needs its pull request URL');
    const state = text(m.state, 20);
    requireThat(['requested', 'drafting', 'drafted', 'stale', 'failed', 'posted', 'dismissed', 'withdrawn'].includes(state), 400, 'invalid review state');
    return { pr, round: identifier(m.round), state,
      ...(m.requestedBy !== undefined ? { requestedBy: text(m.requestedBy, 100) } : {}),
      ...(m.headSha !== undefined ? { headSha: text(m.headSha, 64) } : {}),
      ...(m.stands !== undefined ? { stands: m.stands === true } : {}),
      ...(m.reason !== undefined ? { reason: text(m.reason, 500) } : {}),
      ...(m.open !== undefined ? { open: this.reviewLink(m.open) } : {}) };
  }
  /** Where a review opens: an HTTPS link the boat built from the repo's review tool. */
  private reviewLink(value: unknown): string {
    const link = text(value, 500);
    let url: URL | undefined;
    try { url = new URL(link); } catch { url = undefined; }
    requireThat(url?.protocol === 'https:' && !url.username && !url.password, 400, 'review link must be an https URL');
    return link;
  }
  /** Who an ack is by: the boat under its current name, or the signed-in person. Never a dispatch token. */
  private acker(actor: Actor): string {
    this.hooks.read(actor);
    if (actor.kind === 'person') return 'person';
    return `boat:${this.sql.exec<{ name: string }>('SELECT name FROM boats WHERE id=?', actor.id).toArray()[0]?.name ?? actor.id}`;
  }
  /** The ack of the status a job stands on now. An ack of an earlier status is not one of this. */
  dispatchAck(id: string, statusAt: string | undefined): (WharfAck & { status: string }) | undefined {
    const ack = this.get<WharfAck & { status: string }>('dispatch_acks', id);
    return ack && ack.status === statusAt ? ack : undefined;
  }
  expire(now: number) {
    for (const row of this.sql.exec<{ id: string; data: string }>("SELECT * FROM human_requests WHERE json_extract(data,'$.state') IN ('queued','received','authorized') AND json_extract(data,'$.expiresAt')<=?", new Date(now).toISOString()).toArray()) {
      const r = JSON.parse(row.data) as WharfHumanRequest; r.state = 'expired'; this.put('human_requests', row.id, r);
      if (!r.kind.startsWith('review-')) this.hooks.event('human-request-expired', r.dispatch, r.id);
    }
  }
  /**
   * A linked person's message in their DM with the app. A top-level message
   * asks for new work: one request per Slack message, so a retried delivery
   * finds the same request. A reply in that request's thread adds to it; a
   * reply under anything else (a card's message) is not a request and does
   * nothing. The helm is woken; nothing runs until it acts.
   */
  slackMessage(m: SlackMessageIn, person: string, now: number): { request?: string; ignored?: string } {
    const top = m.threadTs ?? m.ts;
    const id = `slack-${m.channel}-${top.replace('.', '-')}`;
    const r = this.get<WharfHumanRequest>('human_requests', id);
    const at = new Date(now).toISOString();
    if (!m.threadTs) {
      if (r) return { request: id };
      const request: WharfHumanRequest = { id, kind: 'work', by: person, at, expiresAt: new Date(now + WORK_REQUEST_MS).toISOString(), state: 'queued',
        text: m.text, origin: { team: m.team, user: m.user, channel: m.channel, ts: m.ts } };
      this.put('human_requests', id, request); this.hooks.event('human-request', undefined, id);
      return { request: id };
    }
    if (!r || r.kind !== 'work' || !['queued', 'received'].includes(r.state) || Date.parse(r.expiresAt) <= now) return { ignored: 'not an open request thread' };
    if (r.followUps?.some((f) => f.source === m.ts)) return { request: id };
    r.followUps = [...(r.followUps ?? []), { text: m.text, at, source: m.ts }].slice(-20);
    this.put('human_requests', id, r); this.hooks.event('human-request-update', undefined, id);
    return { request: id };
  }
  /** The Slack message a work request came from, for its receipt to reply in that thread. */
  requestOrigin(id: string): WharfHumanRequest['origin'] {
    return this.get<WharfHumanRequest>('human_requests', id)?.origin;
  }
  /** The helm dispatched a work request: it is fulfilled by that dispatch, once. */
  fulfillWork(id: string, dispatch: string, now: number) {
    const r = this.get<WharfHumanRequest>('human_requests', identifier(id));
    requireThat(r && r.kind === 'work' && ['queued', 'received'].includes(r.state) && Date.parse(r.expiresAt) > now, 409, 'no open work request to dispatch');
    r.state = 'fulfilled'; r.dispatch = dispatch; r.outcome = `dispatched as ${dispatch}`;
    this.put('human_requests', r.id, r);
  }
  /** Every published document, withdrawn ones too: a withdrawal ends its card. */
  publishedDocuments(): WharfDocument[] { return this.list<WharfDocument>('documents').filter((d) => d.published); }
  /** Human requests as the glass shows them, with whether one waits for a helm. */
  requestViews(now: number): WharfHumanRequest[] {
    return this.list<WharfHumanRequest>('human_requests').map((r) => ({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) }));
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
  /** A review document's file scope: its uploads raise no event, since every event wakes a helm. */
  isReviewScope(scope: string): boolean {
    return scope.startsWith('document:') && this.get<WharfDocument>('documents', scope.slice('document:'.length))?.kind === 'review';
  }
  /** File uploads are authoring, never a new direct person operational action. */
  uploadScope(c: Command, actor: Actor, now: number): string {
    const d = this.document(c.path.split('/')[1]!);
    this.author(c, actor, now, d.kind, d);
    // A review is republished as its draft and state change; other documents publish once.
    requireThat((d.kind === 'review' || !d.published) && !d.withdrawn, 409, 'document is already published or withdrawn');
    return `document:${d.id}`;
  }
  execute(c: Command, actor: Actor, now: number): Result | undefined {
    const parts = c.path.split('/'), b = c.method === 'GET' ? {} : object(c.body);
    const ok = (value: unknown = {}) => ({ status: 200, value });
    if (c.path === 'workers' && c.method === 'GET') return ok(this.workers());
    if (c.path === 'glass' && c.method === 'GET') return ok({ boats: this.boats(), workers: this.workers(), documents: this.list<WharfDocument>('documents').filter((d) => d.published && !d.withdrawn),
      requests: this.list<WharfHumanRequest>('human_requests').map((r) => ({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) })), helmLive: this.hooks.helmLive(now) });
    if (parts[0] === 'dispatches' && parts.length === 3 && parts[2] === 'ack' && c.method === 'POST') {
      // A person has seen this job's question or landing. No event, no helm seat, no change to the job.
      const by = this.acker(actor), id = identifier(parts[1]);
      requireThat(this.sql.exec('SELECT id FROM dispatches WHERE id=?', id).toArray().length, 404, 'dispatch not found');
      const last = this.sql.exec<{ data: string }>('SELECT data FROM reports WHERE dispatch=? ORDER BY seq DESC LIMIT 1', id).toArray()[0];
      const status = last ? (JSON.parse(last.data) as { at: string }).at : undefined;
      // Keyed on the status time: an ack of what the job said before must not hide what it says now.
      requireThat(status && b.at === status, 409, 'the job has no such current status; read it again before acknowledging');
      const standing = this.dispatchAck(id, status);
      if (standing) return ok(standing);
      const ack = { status, at: new Date(now).toISOString(), by };
      this.put('dispatch_acks', id, ack); return ok(ack);
    }
    if (parts[0] === 'documents') {
      // Boats list decisions and reports; reviews are the hosted glass's (an older boat would refuse the kind).
      if (parts.length === 1 && c.method === 'GET') return ok(this.list<WharfDocument>('documents').filter((d) => d.published && !d.withdrawn && d.kind !== 'review'));
      if (parts.length === 1 && c.method === 'POST') {
        this.author(c, actor, now, b.kind);
        const id = identifier(b.id), title = text(b.title, 200).trim();
        requireThat(title && ['decision', 'report', 'review'].includes(String(b.kind)), 400, 'document needs a title and kind');
        requireThat(!this.get('documents', id), 409, 'document already exists');
        const options = b.options ?? [];
        requireThat(Array.isArray(options) && options.length <= 6 && options.every((o) => typeof o === 'string' && o.trim() === o && o.length > 0 && o.length <= 80) && new Set(options).size === options.length, 400, 'invalid decision options');
        requireThat(b.kind === 'decision' || options.length === 0, 400, 'reports have no options');
        const d: WharfDocument = { id, title, kind: b.kind as WharfDocumentInput['kind'], options, attachments: [], published: false, at: new Date(now).toISOString(), author: `${actor.kind}:${actor.id}` };
        if (d.kind === 'review') d.review = this.reviewMeta(b.review);
        if (b.dispatch !== undefined) { d.dispatch = identifier(b.dispatch); requireThat(this.sql.exec('SELECT id FROM dispatches WHERE id=?', d.dispatch).toArray().length, 404, 'dispatch not found'); }
        this.put('documents', id, d); return ok(d);
      }
      const d = this.document(parts[1]!);
      if (parts.length === 2 && c.method === 'GET') return ok(d);
      if (parts.length === 3 && parts[2] === 'publish' && c.method === 'POST') {
        this.author(c, actor, now, d.kind, d);
        requireThat((d.kind === 'review' || !d.published) && !d.withdrawn, 409, 'document already published or withdrawn');
        if (d.kind === 'review' && b.review !== undefined) d.review = this.reviewMeta(b.review);
        if (b.markdown !== undefined) {
          const [markdown] = this.files(d.id, [b.markdown]);
          requireThat(markdown!.size <= 65536 && /\.md$/i.test(markdown!.name), 400, 'markdown must be a .md file of at most 64 KiB'); d.markdown = markdown;
        }
        requireThat((d.kind !== 'report' && d.kind !== 'review') || d.markdown, 400, `${d.kind} needs a markdown file`);
        d.attachments = this.files(d.id, b.attachments ?? []);
        requireThat(!d.attachments.some((f) => f.id === d.markdown?.id) && new Set(d.attachments.map((f) => f.name)).size === d.attachments.length, 400, 'document attachment names must differ');
        if (b.replace !== undefined) {
          const previous = this.document(identifier(b.replace)); requireThat(previous.kind === 'decision' && !previous.withdrawn && !previous.answer, 409, 'no standing decision to replace');
          previous.withdrawn = true; this.put('documents', previous.id, previous);
        }
        // A review raises no event: every event wakes a helm's wait, and a review is the person's queue, not the fleet's.
        d.published = true; this.put('documents', d.id, d); if (d.kind !== 'review') this.hooks.event(d.kind, d.dispatch, d.id); return ok(d);
      }
      if (parts.length === 3 && parts[2] === 'withdraw' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(d.kind === 'decision' && !d.answer && !d.withdrawn, 409, 'no standing decision to withdraw');
        d.withdrawn = true; this.put('documents', d.id, d); this.hooks.event('decision-withdrawn', d.dispatch, d.id); return ok(d);
      }
      if (parts.length === 3 && parts[2] === 'ack' && c.method === 'POST') {
        // Seen, by a boat with read or the person. The first ack stands. No event and no helm seat.
        const acker = this.acker(actor), by = actor.kind === 'person' && c.token.startsWith('browser:') ? 'glass' : acker; requireThat(d.published && !d.withdrawn, 409, 'document is not published or was withdrawn');
        if (!d.ack) { d.ack = { at: new Date(now).toISOString(), by }; this.put('documents', d.id, d); }
        return ok(d);
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
      if (parts[1] === 'reviews' && parts.length === 2 && c.method === 'GET') {
        // What people asked of this boat's reviews: Post, Edit, Dismiss. The boat carries them out.
        requireThat(actor.kind === 'boat', 403, 'boat scope required');
        return ok(this.list<WharfHumanRequest>('human_requests').filter((r) => r.kind.startsWith('review-') && r.state === 'authorized' && r.boat === actor.id && Date.parse(r.expiresAt) > now));
      }
      if (parts.length === 1 && c.method === 'GET') return ok(this.list<WharfHumanRequest>('human_requests').map((r) => ({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) })));
      if (parts.length === 1 && c.method === 'POST') {
        this.person(actor); const id = identifier(b.id); requireThat(!this.get('human_requests', id), 409, 'request already exists');
        requireThat(['message', 'trap-request', ...WHARF_REVIEW_REQUEST_KINDS].includes(String(b.kind)), 400, 'invalid human request kind');
        const r: WharfHumanRequest = { id, kind: b.kind as WharfHumanRequest['kind'], by: actor.id, at: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: 'queued' };
        if (r.kind.startsWith('review-')) {
          // Dismiss, addressed to the boat that published the review and authorized at once: a person's click on their own review needs no helm.
          const doc = this.document(identifier(b.document));
          requireThat(doc.kind === 'review' && doc.published && !doc.withdrawn && doc.author.startsWith('boat:'), 409, 'no published review to act on');
          r.document = doc.id; r.boat = doc.author.slice('boat:'.length); r.state = 'authorized';
          this.put('human_requests', id, r); return ok(r); // no event: the boat polls requests/reviews, and no helm should wake
        }
        if (r.kind === 'message') { r.dispatch = identifier(b.dispatch); r.text = text(b.text, 16000); requireThat(this.sql.exec('SELECT id FROM dispatches WHERE id=?', r.dispatch).toArray().length, 404, 'dispatch not found'); }
        else { r.boat = identifier(b.boat); r.repo = repoIdentity(b.repo); requireThat(this.sql.exec('SELECT id FROM boats WHERE id=? AND revoked=0', r.boat).toArray().length, 404, 'boat not found'); }
        this.put('human_requests', id, r); this.hooks.event('human-request', r.dispatch, id); return ok({ ...r, waitingForHelm: !this.hooks.helmLive(now) });
      }
      const r = this.get<WharfHumanRequest>('human_requests', identifier(parts[1])); requireThat(r, 404, 'request not found');
      if (parts.length === 3 && parts[2] === 'start' && c.method === 'POST') {
        requireThat(actor.kind === 'boat' && r.boat === actor.id, 403, 'addressed boat required');
        requireThat((r.kind === 'trap-request' || r.kind.startsWith('review-')) && r.state === 'authorized' && Date.parse(r.expiresAt) > now, 409, 'start request is not authorized or expired');
        const review = r.kind.startsWith('review-');
        r.state = 'fulfilled'; r.outcome = b.refused === undefined ? (review ? 'done by the boat' : 'accepted by boat for launch') : text(b.refused, 500);
        this.put('human_requests', r.id, r); if (!review) this.hooks.event('trap-start-accepted', undefined, r.id); return ok(r);
      }
      if (parts.length === 2 && c.method === 'GET') return ok({ ...r, waitingForHelm: r.state === 'queued' && !this.hooks.helmLive(now) });
      if (parts.length === 3 && parts[2] === 'receipt' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(r.state === 'queued' && Date.parse(r.expiresAt) > now, 409, 'request already received or expired');
        r.state = 'received'; this.put('human_requests', r.id, r); this.hooks.event('human-request-received', r.dispatch, r.id); return ok(r);
      }
      if (parts.length === 3 && parts[2] === 'respond' && c.method === 'POST') {
        // The helm answers a work request without dispatching it: a question back, or why not. It stays open.
        this.hooks.helm(c, actor, now);
        requireThat(r.kind === 'work' && ['queued', 'received'].includes(r.state) && Date.parse(r.expiresAt) > now, 409, 'no open work request to respond to');
        r.response = text(b.text, 2000).trim(); requireThat(r.response, 400, 'response needs text');
        r.state = 'received'; this.put('human_requests', r.id, r); return ok(r);
      }
      if (parts.length === 3 && parts[2] === 'execute' && c.method === 'POST') {
        this.hooks.helm(c, actor, now); requireThat(r.state === 'received' && Date.parse(r.expiresAt) > now, 409, 'receipt a live request first');
        requireThat(r.kind !== 'work', 409, 'a work request is fulfilled by dispatching it with --request, or answered with respond');
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
