import { DurableObject } from 'cloudflare:workers';
import type { ReportInput, BackendEvent, DispatchInput, DispatchView, GlassCard, GlassCardAction } from '../../../packages/core/src/backend-model.js';
import { ApiError, LEASE_MS, boatName, capability, digest, dispatchInput, hex, identifier, configuredTarget, object, reportInput, repoIdentity, requireThat, sameHash, text } from './protocol.js';
import { boatPermissions, permits, personPermissions, requiredPermission } from './permissions.js';
import type { Permission } from './permissions.js';
import { personSessionLive } from './auth.js';
import { GlassState, glassSchema, glassTables } from './glass-state.js';
import { Cards } from './cards.js';
import { SlackOutbox } from './slack-outbox.js';
import { installationToken } from './slack-install.js';
import type { SlackLink } from './slack-install.js';
import type { SlackMessageIn } from './slack-ingress.js';
import { routeSlackMessage } from './slack-routing.js';
import { MIRROR_WATCH_MS, MirrorState, attentionJson, mirrorAnswerKey, mirrorFileKey, mirrorSchema, mirrorSnapshotKey, mirrorTables } from './mirror-state.js';
import type { MirrorCleanup } from './mirror-state.js';
import { MIRROR_SNAPSHOT_MAX_JSON_BYTES } from '../../../packages/core/src/backend-model.js';
import { ANSWER_INLINE_MAX_BYTES, MINIMUM_SOCKET_CLIENT, PING_TEXT, PONG_TEXT, SOCKET_EVENTS_PER_MESSAGE, WHARF_SOCKET_PROTOCOL, encodeFrame, offersSocketProtocol, parseClientMessage } from '../../../packages/core/src/wharf-socket.js';
import type { CallMessage, CommandMessage, ServerSocketMessage, SocketFrame } from '../../../packages/core/src/wharf-socket.js';

export type Actor = { kind: 'person' | 'boat'; id: string; permissions: Permission[] } | { kind: 'dispatch'; id: string; epoch: number };
/** What a Slack action came to: done, a form to ask for words first, or why not, said to the person. */
export type SlackActionResult = { done: true } | { form: { title: string; prompt: string } } | { refused: string };
type DispatchRow = { id: string; data: string; state: string; worker: string | null; boat: string | null; epoch: number; lease: number; hash: string | null; nonce: string | null };
type BoatRow = { id: string; name: string; hash: string; revoked: number };
type WorkerRow = { id: string; boat: string; repo?: string; seen: number; target?: import('../../../packages/core/src/configured-trap-model.js').ConfiguredTrapTarget };
type StoredResult = { status: number; value: unknown };
/**
 * What a socket keeps across hibernation (well under the 16 KB attachment
 * limit): who it is, its credential's hash (never the secret), and the
 * command fields its messages run under.
 */
type SocketAttachment = { actor: Actor; hash: string; account: string; sessionId?: string; protocol: typeof WHARF_SOCKET_PROTOCOL;
  base: Pick<Command, 'account' | 'helm' | 'personId' | 'personSessionId' | 'token'> };
/** The most sockets one account holds at once: boats, glass tabs and waiting helms together. */
const SOCKET_LIMIT = 256;
type FileRow = { id: string; dispatch: string; name: string; size: number; hash: string; ready: number };
export type Command = { account: string; helm: boolean; personId?: string; token: string; method: string; path: string; key?: string; session?: string; body: unknown; after?: string;
  personSessionId?: string;
  prepared?: { id?: string; hash: string } };
const HELM_MS = 120_000;

/**
 * How long a mutation's Idempotency-Key replays its first result. Clients
 * never retry on their own: a timeout says the state is unknown, and a person
 * or agent runs the command again with `--request-key` (a multi-step publish
 * resumes from its base key; a boat reports a card answer under
 * `answer-<receipt>` each pass until it settles). A day covers a retry after
 * an outage or in the next session; after it, the same key runs as new.
 */
export const IDEM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One account's only coordination authority. Clients hold hibernatable
 * sockets (lobstah.2) and get each event pushed; pings are answered by the
 * runtime without waking the object. One alarm, set only while something is
 * due (a lease, a paused report's end, a live mirror call, an open request, a
 * waiting card answer, a Slack retry), stands in for the polls that used to
 * observe expiry; with nothing due there is no alarm and no timer.
 */
export class Account extends DurableObject<Env> {
  private glass: GlassState;
  private cards: Cards;
  private outbox: SlackOutbox;
  private mirrorState: MirrorState;
  /** The newest event already pushed to sockets; events after it go out on the next push. */
  private pushedSeq = 0;
  private pushPending = false;
  /** Relays held open over HTTP, waiting for their call's answer, by call id. */
  private readonly answerWaiters = new Map<string, Array<() => void>>();
  /** Fetch is only for the private upgrade binding: normal state uses RPC. */
  async fetch(request: Request): Promise<Response> {
    try {
      requireThat(request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket', 400, 'websocket upgrade required');
      const c: Command = JSON.parse(request.headers.get('X-Wharf-Command') ?? '{}');
      requireThat(c.path === 'wake' && c.method === 'GET' && typeof c.token === 'string', 400, 'invalid wake request');
      const hash = await digest(c.token.startsWith('b.') || c.token.startsWith('d.') ? c.token.split('.').at(-1)! : c.token);
      requireThat(!this.get('deleted'), 410, 'account deleted');
      const actor = this.authenticate(c, hash, Date.now());
      this.requirePermission(actor, 'read'); this.budget(Date.now());
      requireThat(actor.kind !== 'person' || c.personSessionId && await personSessionLive(this.env, c.account, c.personSessionId), 401, 'session expired');
      requireThat(!this.get('deleted'), 410, 'account deleted');
      // A client from before the socket protocol is told to update, never served the old hints.
      if (!offersSocketProtocol(request.headers.get('Sec-WebSocket-Protocol'))) {
        return Response.json({ error: `this wharf speaks ${WHARF_SOCKET_PROTOCOL}; update lobstah to ${MINIMUM_SOCKET_CLIENT} or later`, minimumClient: MINIMUM_SOCKET_CLIENT }, { status: 426 });
      }
      requireThat(this.ctx.getWebSockets().length < SOCKET_LIMIT, 429, 'socket connection limit');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], socketTags(actor, c));
      const attachment: SocketAttachment = { actor, hash, account: c.account, sessionId: c.personSessionId, protocol: WHARF_SOCKET_PROTOCOL,
        base: { account: c.account, helm: c.helm, personId: c.personId, personSessionId: c.personSessionId, token: credentialName(c.token) } };
      pair[1].serializeAttachment(attachment);
      // A glass tab open is what makes mirror boats put their snapshots at once.
      if (isGlass(c)) this.ctx.waitUntil(this.mirrorHint('all', { type: 'mirror-watch', until: new Date(Date.now() + MIRROR_WATCH_MS).toISOString() }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': WHARF_SOCKET_PROTOCOL } });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      return Response.json({ error: 'wake unavailable' }, { status: 503 });
    }
  }
  /**
   * One message from a client: catch up from a cursor, or run a command as
   * its HTTP route would. The socket's credential is checked again first; a
   * revoked or expired one closes the socket.
   */
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const a = socket.deserializeAttachment() as SocketAttachment | null;
    if (!a || a.protocol !== WHARF_SOCKET_PROTOCOL) return void socket.close(1008, 'unknown socket');
    if (!await this.socketAllowed(a)) return void socket.close(1008, 'credential expired or revoked');
    // The runtime answers pings while the object hibernates; one that reaches a live instance gets the same answer.
    if (data === PING_TEXT) return void socket.send(PONG_TEXT);
    if (typeof data !== 'string') return void send(socket, { t: 'error', reason: 'binary messages are not accepted yet' });
    const message = parseClientMessage(data);
    if ('invalid' in message) return void send(socket, { t: 'error', reason: message.invalid });
    if (message.t === 'resume') return void this.resume(socket, message.after);
    if (message.t === 'call') return void send(socket, { t: 'result', id: message.id, ...await this.socketCall(a, message) });
    send(socket, { t: 'result', id: message.id, ...await this.socketCommand(a, message) });
    await this.afterChange();
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code === 1005 || code === 1006 ? 1000 : code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'socket connection failed'); }
  /** Whether a socket's credential still holds: a boat not revoked, with read; a person's session still live. */
  private async socketAllowed(a: SocketAttachment): Promise<boolean> {
    if (this.get('deleted')) return false;
    if (a.actor.kind === 'boat') {
      const row = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', a.actor.id).toArray()[0];
      const grants = this.ctx.storage.sql.exec<{ permissions: string }>('SELECT permissions FROM boat_permissions WHERE boat=?', a.actor.id).toArray()[0];
      return !!row && !row.revoked && sameHash(row.hash, a.hash) && permits(grants ? JSON.parse(grants.permissions) : ['work'], 'read');
    }
    return a.actor.kind === 'person' && !!a.sessionId && await personSessionLive(this.env, a.account, a.sessionId);
  }
  /** Send every event after `after`, in messages of at most SOCKET_EVENTS_PER_MESSAGE, then hello with the newest cursor. */
  private resume(socket: WebSocket, after: string | undefined) {
    const generation = this.get('generation')!;
    let seq = 0;
    if (after !== undefined) {
      const [g, n] = after.split('.');
      // Another generation is another account's history: the client starts again from now.
      seq = g === generation && /^\d+$/.test(n ?? '') && Number.isSafeInteger(Number(n)) ? Number(n) : this.newestSeq();
    } else seq = this.newestSeq();
    for (;;) {
      const page = this.eventsAfter(seq, SOCKET_EVENTS_PER_MESSAGE);
      if (!page.events.length) break;
      send(socket, { t: 'event', events: page.events, cursor: page.cursor });
      seq = page.seq;
    }
    send(socket, { t: 'hello', protocol: WHARF_SOCKET_PROTOCOL, cursor: `${generation}.${seq}` });
  }
  /** A socket's command, run as its HTTP route under the socket's own credential. Claims and enrolment stay HTTP: they mint credentials. */
  private async socketCommand(a: SocketAttachment, m: CommandMessage): Promise<StoredResult> {
    // A glass tab's cookie reaches only the glass's own routes (glass-browser.ts); its socket runs no command until it has the same list.
    if (a.base.token.startsWith('browser:')) return { status: 403, value: { error: 'the glass sends its commands over HTTP' } };
    if (m.path === 'claims' || m.path === 'boats' || m.path.startsWith('_')) return { status: 400, value: { error: `${m.path} is HTTP only` } };
    const c: Command = { ...a.base, method: m.method, path: m.path, key: m.id, body: m.method === 'GET' ? {} : (m.body ?? {}), ...(m.session ? { session: m.session } : {}) };
    try {
      return await this.command(c, a.hash);
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, value: { error: e.message } };
      throw e;
    }
  }
  /**
   * A glass tab's relayed call: made exactly as the HTTP relay makes it
   * (`POST mirror/calls`), and answered later by an `answer` frame when the
   * boat answers. The result says it was accepted (202), or why not; the same
   * id again is the same call (409 means it already stands).
   */
  private async socketCall(a: SocketAttachment, m: CallMessage): Promise<StoredResult> {
    if (a.actor.kind !== 'person') return { status: 403, value: { error: 'only a signed-in person relays calls' } };
    const body = { id: m.id, boat: m.boat, ...(m.read !== undefined ? { read: m.read } : {}), ...(m.write !== undefined ? { write: m.write } : {}), ...(m.files ? { files: m.files } : {}) };
    const c: Command = { ...a.base, method: 'POST', path: 'mirror/calls', body };
    const created = JSON.parse(await this.mirror(JSON.stringify(c))) as StoredResult;
    if (created.status === 200 || created.status === 409) return { status: 202, value: { id: m.id } };
    return created;
  }
  /** Send a binary frame to every glass tab whose session still holds. */
  private async pushFrame(header: SocketFrame, payload?: Uint8Array) {
    const frame = encodeFrame(header, payload);
    for (const socket of this.ctx.getWebSockets('glass')) {
      try {
        const a = socket.deserializeAttachment() as SocketAttachment | null;
        if (a?.protocol === WHARF_SOCKET_PROTOCOL && await this.socketAllowed(a)) socket.send(frame);
        else socket.close(1008, 'credential expired or revoked');
      } catch { try { socket.close(1011, 'socket unavailable'); } catch { /* disconnected */ } }
    }
  }
  /**
   * Private binding only: hold an HTTP relay until its call is answered (or
   * expires), or `ms` passes. The relay then reads the answer once, instead
   * of polling the call.
   */
  async awaitMirrorAnswer(id: string, ms: number): Promise<void> {
    const call = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM mirror_calls WHERE id=?', id).toArray()[0];
    if (!call) return;
    const state = (JSON.parse(call.data) as { state: string }).state;
    if (state === 'answered' || state === 'expired') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const rest = (this.answerWaiters.get(id) ?? []).filter((w) => w !== done);
        if (rest.length) this.answerWaiters.set(id, rest); else this.answerWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.answerWaiters.set(id, [...(this.answerWaiters.get(id) ?? []), done]);
    });
  }
  /**
   * Push the events after the last pushed one to every socket whose
   * credential still holds, and close the rest. Events from one command go
   * out together: a push already scheduled carries the later ones too.
   */
  private async push() {
    const page = this.eventsAfter(this.pushedSeq, SOCKET_EVENTS_PER_MESSAGE);
    if (!page.events.length) return;
    this.pushedSeq = page.seq;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const a = socket.deserializeAttachment() as SocketAttachment | null;
        if (a?.protocol === WHARF_SOCKET_PROTOCOL && await this.socketAllowed(a)) send(socket, { t: 'event', events: page.events, cursor: page.cursor });
        else socket.close(1008, 'credential expired or revoked');
      } catch { try { socket.close(1011, 'socket unavailable'); } catch { /* disconnected */ } }
    }
    // More than one message's worth: the rest go in the next push.
    if (this.eventsAfter(this.pushedSeq, 1).events.length) await this.push();
  }
  /** The newest event's sequence number; 0 for an account with none. */
  private newestSeq(): number {
    return this.ctx.storage.sql.exec<{ seq: number | null }>('SELECT max(seq) AS seq FROM events').one().seq ?? 0;
  }
  /** Up to `limit` events after `after`, as clients read them, with the newest one's cursor and sequence number. */
  private eventsAfter(after: number, limit: number): { events: BackendEvent[]; cursor: string; seq: number } {
    const generation = this.get('generation')!;
    const rows = this.ctx.storage.sql.exec<{ seq: number; kind: string; dispatch: string | null; at: string; note: string | null }>('SELECT e.*,d.note FROM events e LEFT JOIN event_details d ON d.seq=e.seq WHERE e.seq>? ORDER BY e.seq LIMIT ?', after, limit).toArray();
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
    const seq = rows.at(-1)?.seq ?? after;
    return { events, cursor: `${generation}.${seq}`, seq };
  }
  /**
   * The earliest time something becomes due without any request: a lease
   * ends (or a paused report's hold), a worker goes stale while untargeted
   * work waits, a live mirror call or an open request expires, a card answer
   * no boat took expires, or a Slack delivery's retry comes round. None when
   * nothing is due.
   */
  private nextDue(now: number): number | undefined {
    const times: number[] = [];
    for (const d of this.ctx.storage.sql.exec<{ id: string; lease: number }>("SELECT id,lease FROM dispatches WHERE state='active'").toArray()) {
      if (d.lease > now) { times.push(d.lease); continue; }
      const last = this.lastReport(d.id);
      if (last?.verb === 'paused' && Date.parse(last.until ?? '') > now) times.push(Date.parse(last.until!));
    }
    // A worker that goes stale can leave untargeted queued work with no one to serve it: the glass says so.
    if (this.ctx.storage.sql.exec("SELECT 1 FROM dispatches WHERE state='queued' AND json_extract(data,'$.target') IS NULL LIMIT 1").toArray().length) {
      const stale = this.ctx.storage.sql.exec<{ at: number | null }>('SELECT min(seen) AS at FROM workers WHERE seen>?', now - LEASE_MS).one().at;
      if (stale !== null) times.push(stale + LEASE_MS);
    }
    for (const at of [this.mirrorState.nextExpiry(now), this.glass.nextExpiry(now), this.cards.nextExpiry(now), this.outbox.nextDue()]) if (at !== undefined) times.push(at);
    return times.length ? Math.max(Math.min(...times), now) : undefined;
  }
  /** Set the alarm to the next due time, move it when that changed, or delete it when nothing is due. */
  private async scheduleAlarm() {
    if (this.get('deleted')) return void await this.ctx.storage.deleteAlarm();
    const next = this.nextDue(Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (next === undefined) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
    else if (current !== next) await this.ctx.storage.setAlarm(next);
  }
  /** After anything that may have changed what is due: deliver to Slack what is due now, then move the alarm. */
  private async afterChange() {
    if (!this.get('deleted') && this.outbox.due(Date.now())) this.ctx.waitUntil(this.outbox.drain().catch(() => {}).then(() => this.scheduleAlarm()));
    await this.scheduleAlarm();
  }
  /**
   * The alarm: observe what came due with no request (expired leases and
   * requests, stale workers, expired calls and answers), push the events it
   * made, deliver Slack retries, and set the next alarm.
   */
  async alarm() {
    if (this.get('deleted')) return;
    const now = Date.now();
    const account = this.ctx.id.name;
    const cleanup = this.ctx.storage.transactionSync(() => {
      this.expire(now); this.availability(now);
      const keys = this.mirrorState.expire(account ?? '', now);
      this.cards.project(now);
      return keys;
    });
    // Without the account's name its R2 keys are unknown; the next mirror request removes them.
    if (account) this.dropMirrorFiles(cleanup);
    if (this.outbox.due(now)) await this.outbox.drain().catch(() => {});
    await this.push();
    await this.scheduleAlarm();
  }
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
    } finally {
      // After the command commits, its card changes go out; a failed drain is retried by the alarm.
      await this.afterChange();
    }
  }
  /** Private binding only: deliver what is due now, and wait for it. */
  async deliverSlack(): Promise<void> { await this.outbox.drain(); }
  /** Grounds observed from explicit card and dispatch ownership, offered by the signed-in link picker. */
  async slackGrounds(): Promise<string[]> {
    const names = new Set(this.cards.store.list(Date.now()).flatMap((card) => card.grounds ? [card.grounds] : []));
    for (const row of this.ctx.storage.sql.exec<{ grounds: string | null }>("SELECT DISTINCT json_extract(data,'$.grounds') AS grounds FROM dispatches").toArray()) if (row.grounds) names.add(row.grounds);
    return [...names].sort();
  }
  /** Private binding only: a person's Slack link as D1 now holds it, or none. Changes no card. */
  async linkSlack(person: string, link: SlackLink | null): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.outbox.link(person, link, this.cards.store.list(now).filter((c) => !c.terminal), now);
      this.cards.restrictSlackAnswers(person, (grounds) => this.outbox.serves(person, grounds), now);
    });
    await this.afterChange();
  }
  /**
   * Private binding only: a verified DM message from this account's linked
   * person. It is recorded, and its receipt queued, before Slack hears back.
   */
  async slackMessage(person: string, message: SlackMessageIn): Promise<{ request?: string; ignored?: string; question?: { threadTs: string; grounds: string[] } }> {
    const result = this.ctx.storage.transactionSync(() => {
      requireThat(!this.get('deleted'), 410, 'account deleted');
      const now = Date.now(); this.expire(now); this.capacity();
      const route = routeSlackMessage(this.ctx.storage.sql, person, message, this.outbox.grounds(person), now);
      if (!('message' in route)) return route;
      const recorded = this.glass.slackMessage(route.message, person, now, route.grounds);
      this.cards.project(now);
      return recorded;
    });
    await this.afterChange();
    return result;
  }
  /** The routing question was posted; a replay need not post another one. */
  async slackGroundsPrompted(person: string, channel: string, threadTs: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE slack_ground_requests SET prompted=1 WHERE person=? AND channel=? AND ts=?', person, channel, threadTs);
  }
  /**
   * Private binding only: the linked person pressed a button on a card's
   * Slack message, or sent its answer form. The handle must be theirs, live,
   * and for the card's current state; the action then goes through the same
   * path as the glass, and the first valid answer stands.
   */
  async slackAction(person: string, handle: string, answer?: string): Promise<SlackActionResult> {
    const result = this.ctx.storage.transactionSync((): SlackActionResult => {
      requireThat(!this.get('deleted'), 410, 'account deleted');
      const now = Date.now(); this.expire(now);
      const pressed = this.outbox.pressed(person, handle, now);
      if ('refused' in pressed) {
        // An older message shows the card as it now stands.
        if (pressed.card) this.outbox.refresh(person, pressed.card, now);
        return { refused: pressed.refused === 'expired' ? 'This button expired. Open the card again from its newest message or the glass.' : 'This card changed since. Its message now shows where it stands.' };
      }
      const done = this.cardAction(pressed.card, pressed.action, person, answer, now);
      this.cards.project(now);
      return done;
    });
    await this.afterChange();
    return result;
  }
  /**
   * One action on a card. The wharf's own cards go through the glass's own
   * path. A boat's card gets a receipt for that boat, which alone applies it.
   * A form is asked for first when an answer needs words.
   */
  private cardAction(card: GlassCard, action: GlassCardAction, person: string, answer: string | undefined, now: number): SlackActionResult {
    const words = answer?.trim();
    const form = (prompt: string): SlackActionResult => ({ form: { title: card.title, prompt } });
    if (card.source !== 'wharf') {
      if (action.kind === 'answer-text' && !words) return form('Your answer');
      return this.cards.answerForBoat(card, action, action.kind === 'answer-text' ? words : undefined, person, now);
    }
    try {
      if (card.family === 'decision' && action.kind === 'answer') this.glass.answerDecision(card.key, action.option, undefined, person, now);
      else if (card.family === 'decision' && action.kind === 'answer-text') { if (!words) return form('Your answer'); this.glass.answerDecision(card.key, undefined, words, person, now); }
      else if ((card.family === 'decision' || card.family === 'report') && action.kind === 'seen') this.glass.ackDocument(card.key, 'slack', now);
      else if ((card.family === 'question' || card.family === 'landed') && action.kind === 'seen') this.glass.ackDispatch(card.key.split('@')[0]!, card.sourceAt, 'slack', now);
      else if ((card.family === 'question' || card.family === 'dispatch') && action.kind === 'message-helm') {
        if (!words) return form('Your message to the helm');
        this.glass.messageJob(card.key.split('@')[0]!, words, person, now);
      } else return { refused: 'Answer this card in the glass.' };
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) return { refused: e.message };
      throw e;
    }
    return { done: true };
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
      CREATE TABLE IF NOT EXISTS configured_workers (id TEXT PRIMARY KEY, boat TEXT NOT NULL, target TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_nicknames (worker TEXT PRIMARY KEY, nickname TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unservable (dispatch TEXT PRIMARY KEY, repo TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, worker TEXT, boat TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0, hash TEXT, nonce TEXT);
      CREATE INDEX IF NOT EXISTS dispatch_worker ON dispatches(worker, state);
      CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dispatch TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_details (seq INTEGER PRIMARY KEY, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idem (actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, at INTEGER, PRIMARY KEY(actor,key));
      CREATE TABLE IF NOT EXISTS recoveries (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (dispatch TEXT NOT NULL, epoch INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(dispatch,epoch));
      CREATE TABLE IF NOT EXISTS catch_context (dispatch TEXT PRIMARY KEY, claim_helm INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistance_results (child TEXT PRIMARY KEY, parent TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistance_stops (child TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, dispatch TEXT NOT NULL, text TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, dispatch TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
      ${glassSchema}
      ${mirrorSchema}
    `);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO meta VALUES (?,?)', 'generation', crypto.randomUUID());
    // An idem record says when it was made, so it can expire. Records from before then have no time, and go first.
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(idem)').toArray().some((c) => c.name === 'at')) ctx.storage.sql.exec('ALTER TABLE idem ADD COLUMN at INTEGER');
    // Request counts and the hosted glass's watch moved to memory; their old rows go (nothing to write once gone).
    ctx.storage.sql.exec("DELETE FROM meta WHERE key IN ('budget','mirror-budget','mirror-watched')");
    this.glass = new GlassState(ctx.storage.sql, { helm: (c, a, n) => this.helm(c, a, n), read: (a) => this.requirePermission(a, 'read'), work: (a) => this.requirePermission(a, 'work'), event: (k, d, note) => this.event(k, d, note),
      helmLive: (now) => this.helmLive(now) });
    this.cards = new Cards(ctx.storage.sql, {
      dispatches: () => ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches ORDER BY rowid DESC LIMIT 100').toArray().map((d) => this.view(d) as DispatchView),
      documents: () => this.glass.publishedDocuments(), requests: (now) => this.glass.requestViews(now),
      workers: () => this.glass.workers(), boats: () => this.glass.boats(),
    }, {
      read: (a) => this.requirePermission(a, 'read'),
      // Work-only boats run traps, so they hold permission requests: either layer may restate its own cards.
      publish: (a) => requireThat(a.kind === 'boat' && (permits(a.permissions, 'read') || permits(a.permissions, 'work')), 403, 'boat credential required'),
      changed: (cards, now) => this.outbox.mark(cards, now),
    });
    this.outbox = new SlackOutbox(ctx.storage.sql, {
      glassOrigin: env.GLASS_ORIGIN, card: (seq) => this.cards.store.get(`c${seq}`),
      // The workspace installation's own bot token, sealed at rest in D1.
      token: (team) => installationToken(env, team),
      // The wharf's own cards act through the glass's paths; a boat's cards become receipts that boat applies.
      // While an answer awaits its boat, or was applied, the card offers nothing more.
      controllable: (card) => {
        if (card.relay && (card.relay.state === 'awaiting boat' || card.relay.state === 'applied')) return [];
        const kinds = card.source === 'wharf' ? ['answer', 'answer-text', 'seen', 'message-helm'] : ['answer', 'answer-text', 'allow-once', 'allow-always', 'deny', 'seen'];
        return card.actions.filter((a) => kinds.includes(a.kind));
      },
      // A work request's receipt replies in the thread of the message that asked, in that same DM.
      thread: (card, channel) => {
        const origin = card.source === 'wharf' && card.family === 'request' ? this.glass.requestOrigin(card.key) : undefined;
        return origin?.channel === channel ? origin.ts : undefined;
      },
    });
    this.mirrorState = new MirrorState(ctx.storage.sql, { read: (a) => this.requirePermission(a, 'read'), mirror: (a) => this.requirePermission(a, 'mirror') });
    // Keepalives never wake the object: the runtime answers them, even while it hibernates.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    // Events made before this instance started were pushed by the one before it, or are a resume's to replay.
    this.pushedSeq = this.newestSeq();
  }
  /**
   * Request counts per minute, and until when a hosted glass is open, kept in
   * this instance's memory, never in SQLite: they change on every request, and
   * a row written per request (about 3 rows_written each) is what spends the
   * Durable Objects free tier. An evicted instance starts the minute's count
   * again, and the next hosted glass poll says it is open again.
   */
  private readonly budgets = new Map<'account' | 'mirror', { window: number; count: number }>();
  private mirrorWatchedUntil = 0;
  /** Count one request against a per-minute budget, or refuse it. */
  private spend(which: 'account' | 'mirror', limit: number, now: number, message: string) {
    const window = Math.floor(now / 60000);
    const b = this.budgets.get(which);
    const count = b?.window === window ? b.count : 0;
    requireThat(count < limit, 429, message);
    this.budgets.set(which, { window, count: count + 1 });
  }
  private get(key: string): string | undefined {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', key).toArray()[0]?.value;
  }
  private helmLive(now: number): boolean { return Number(JSON.parse(this.get('helm') ?? '{}').until) > now; }
  private set(key: string, value: string) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta VALUES (?,?)', key, value); }
  private dispatch(id: string): DispatchRow {
    const d = this.ctx.storage.sql.exec<DispatchRow>('SELECT * FROM dispatches WHERE id=?', id).toArray()[0];
    requireThat(d, 404, 'dispatch not found'); return d;
  }
  private event(kind: string, dispatch?: string, note?: string) {
    this.ctx.storage.sql.exec('INSERT INTO events(kind,dispatch,at) VALUES (?,?,?)', kind, dispatch ?? null, new Date().toISOString());
    if (note) this.ctx.storage.sql.exec('INSERT INTO event_details VALUES (last_insert_rowid(),?)', note);
    // After the command's transaction commits, its events go to every socket.
    if (!this.pushPending && this.ctx.getWebSockets().length) {
      this.pushPending = true;
      this.ctx.waitUntil(Promise.resolve().then(() => { this.pushPending = false; return this.push(); }));
    }
  }
  private targetBoat(d: DispatchInput): BoatRow | undefined {
    return d.boat ? this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', d.boat).toArray()[0] : undefined;
  }
  /** Which queued work no online worker can serve. Runs on every command, and on the alarm when a worker goes stale. */
  private availability(now: number) {
    const absent = this.ctx.storage.sql.exec<DispatchRow>(`SELECT d.* FROM dispatches d WHERE d.state='queued' AND json_extract(d.data,'$.target') IS NULL AND NOT EXISTS (
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
    const status = this.lastReport(d.id), ack = this.glass.dispatchAck(d.id, status?.at);
    const assistance = this.ctx.storage.sql.exec<DispatchRow>(`SELECT * FROM dispatches WHERE json_extract(data,'$.target.parentDispatch')=? ORDER BY rowid LIMIT 32`, d.id).toArray().map((child) => ({ id: child.id, state: child.state, note: this.lastReport(child.id)?.note, files: this.ctx.storage.sql.exec<{ id: string; name: string; size: number }>('SELECT id,name,size FROM files WHERE dispatch=? AND ready=1 LIMIT 32', child.id).toArray() }));
    return { ...input, ...(assistance.length ? { assistance } : {}), state: d.state, status, ...(ack ? { ack } : {}), ...(d.worker ? { workerId: d.worker } : {}), ...(d.boat ? { claimedBoat: d.boat } : {}), ...(target ? { boatName: target.name } : {}), ...(unservable ? { unservable } : {}) };
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
    this.glass.expire(now);
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
  /**
   * Drop the oldest idem record once it is past the retry window: one row at
   * most per command, read by rowid (insertion order), so no scan and no
   * index. Each command adds one record and takes at most one expired one, so
   * the table settles at a window's worth of commands, and a backlog drains
   * one row per command.
   */
  private trimIdem(now: number) {
    const oldest = this.ctx.storage.sql.exec<{ id: number; at: number | null }>('SELECT rowid AS id, at FROM idem ORDER BY rowid LIMIT 1').toArray()[0];
    if (oldest && (oldest.at === null || oldest.at <= now - IDEM_WINDOW_MS)) this.ctx.storage.sql.exec('DELETE FROM idem WHERE rowid=?', oldest.id);
  }
  private budget(now: number) { this.spend('account', Number(this.env.REQUESTS_PER_MINUTE), now, 'account rate limit'); }
  /** The account's stored rows, against MAX_ROWS. Idem records are left out: the retry window bounds them (trimIdem). */
  private capacity() {
    const tables = ['boats', 'boat_permissions', 'workers', 'configured_workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'recoveries', 'claims', 'catch_context', 'messages', 'assistance_results', 'assistance_stops', 'files', ...glassTables, ...mirrorTables];
    const count = tables.reduce((n, t) => n + this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n, 0);
    requireThat(count < Number(this.env.MAX_ROWS) && this.ctx.storage.sql.databaseSize < Number(this.env.MAX_ACCOUNT_BYTES), 507, 'account storage limit');
  }
  /** One command in one transaction. A socket's command passes its credential's stored hash: the socket never keeps the secret. */
  async command(c: Command, credentialHash?: string): Promise<StoredResult> {
    const hash = credentialHash ?? await digest(c.token.startsWith('d.') || c.token.startsWith('b.') ? c.token.split('.').at(-1)! : c.token);
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
      // The wharf's cards move in the same transaction as the records they show.
      this.cards.project(now);
      if (c.method !== 'GET') {
        this.ctx.storage.sql.exec('INSERT INTO idem(actor,key,fingerprint,result,at) VALUES (?,?,?,?,?)', `${actor.kind}:${actor.id}`, c.key!, fingerprint, JSON.stringify(result), now);
        this.trimIdem(now);
      }
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
      const d = w.target ? this.ctx.storage.sql.exec<DispatchRow>(`SELECT * FROM dispatches WHERE state='queued'
        AND json_extract(data,'$.target.profile')=? AND json_extract(data,'$.target.grounds')=? AND json_extract(data,'$.target.surface')=?
        AND (json_extract(data,'$.boat') IS NULL OR json_extract(data,'$.boat')=?) ORDER BY rowid LIMIT 1`, w.target.profile, w.target.grounds, w.target.surface, actor.id).toArray()[0]
        : this.ctx.storage.sql.exec<DispatchRow>(`SELECT * FROM dispatches WHERE state='queued' AND json_extract(data,'$.target') IS NULL
        AND json_extract(data,'$.repoRemote')=? AND (json_extract(data,'$.for')=? OR json_extract(data,'$.for') IS NULL)
        AND (json_extract(data,'$.boat') IS NULL OR json_extract(data,'$.boat')=?)
        ORDER BY CASE WHEN json_extract(data,'$.for')=? THEN 0 ELSE 1 END, rowid LIMIT 1`, w.repo, w.id, actor.id, w.id).toArray()[0];
      if (!d) return ok(null);
      const epoch = d.epoch + 1;
      this.ctx.storage.sql.exec("UPDATE dispatches SET state='active',worker=?,boat=?,epoch=?,lease=?,hash=? WHERE id=?", w.id, actor.id, epoch, now + LEASE_MS, c.prepared.hash, d.id);
      this.ctx.storage.sql.exec('INSERT INTO claims VALUES (?,?,?)', d.id, epoch, c.prepared.hash);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO catch_context VALUES (?,?)', d.id, Number(this.helmLive(now)));
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
      return ok(this.glass.boats());
    }
    if (c.path.startsWith('boats/') && c.path.endsWith('/revoke') && c.method === 'POST') {
      this.requirePermission(actor, 'admin');
      const id = identifier(c.path.split('/')[1]); const target = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', id).toArray()[0];
      requireThat(target, 404, 'boat not found');
      this.ctx.storage.sql.exec('UPDATE boats SET revoked=1 WHERE id=?', id); this.event('boat-revoked', undefined, `boat: ${target.name}`);
      // A revoked boat mirrors nothing: its snapshot and calls are dropped with its credential.
      this.dropMirrorFiles(this.mirrorState.forget(c.account, id)); return ok();
    }
    if (c.path === 'workers/sign-on' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required');
      requireThat(b.boat === undefined, 400, 'boat credentials cannot select another boat');
      const id = identifier(b.worker);
      if (b.target !== undefined) {
        const target = configuredTarget(b.target);
        requireThat(!target.parentDispatch && b.repo === undefined && b.repoRemote === undefined, 400, 'configured worker has no repo or assistance parent');
        requireThat(target.surface !== 'claude-desktop' || b.harness === 'claude', 400, 'desktop profile requires Claude');
        requireThat(!this.ctx.storage.sql.exec('SELECT id FROM workers WHERE id=?', id).toArray().length, 409, 'worker identity already belongs to a repo trap');
        const old = this.ctx.storage.sql.exec<{ id: string; boat: string; repo: string; seen: number }>('SELECT * FROM configured_workers WHERE id=?', id).toArray()[0];
        requireThat(!old || old.boat === actor.id, 409, 'worker belongs to another boat');
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO configured_workers VALUES (?,?,?,?)', id, actor.id, JSON.stringify(target), now);
        this.glass.worker(id, { ...b, target }); this.event('worker-signed-on'); return ok({ id, target });
      }
      requireThat(!this.ctx.storage.sql.exec('SELECT id FROM configured_workers WHERE id=?', id).toArray().length, 409, 'worker identity already belongs to a configured trap');
      const repo = repoIdentity(b.repoRemote); const nickname = identifier(b.repo);
      const old = this.ctx.storage.sql.exec<{ id: string; boat: string; repo: string; seen: number }>('SELECT * FROM workers WHERE id=?', id).toArray()[0];
      requireThat(!old || old.boat === actor.id, 409, 'worker belongs to another boat');
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO workers VALUES (?,?,?,?)', id, actor.id, repo, now);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO worker_nicknames VALUES (?,?)', id, nickname);
      this.glass.worker(id, b);
      this.event('worker-signed-on'); return ok({ id, repo: nickname, repoRemote: repo });
    }
    if (c.path === 'workers/renew' && c.method === 'POST') {
      requireThat(actor.kind === 'boat', 403, 'boat scope required'); const w = this.worker(b.worker, actor.id);
      requireThat(b.boat === undefined, 400, 'boat credentials cannot select another boat');
      this.ctx.storage.sql.exec(w.target ? 'UPDATE configured_workers SET seen=? WHERE id=?' : 'UPDATE workers SET seen=? WHERE id=?', now, w.id);
      this.ctx.storage.sql.exec("UPDATE dispatches SET lease=? WHERE worker=? AND boat=? AND state='active'", now + LEASE_MS, w.id, actor.id);
      return ok();
    }
    if (c.path === 'dispatches' && c.method === 'POST') {
      this.helm(c, actor, now); const d = dispatchInput(b);
      if (d.boat) requireThat(this.targetBoat(d), 404, 'target boat not found');
      requireThat(!this.ctx.storage.sql.exec('SELECT id FROM dispatches WHERE id=?', d.id).toArray().length, 409, 'dispatch already exists');
      if (d.followUp) this.dispatch(d.followUp);
      // A dispatch that answers a person's work request fulfills it in the same transaction.
      if (d.request) this.glass.fulfillWork(d.request, d.id, now, d.grounds);
      if (d.target?.parentDispatch) {
        const parent = this.dispatch(d.target.parentDispatch), origin = JSON.parse(parent.data) as DispatchInput;
        requireThat(['queued', 'active'].includes(parent.state), 409, 'assistance parent has ended');
        requireThat(!origin.grounds || origin.grounds === d.target.grounds, 400, 'assistance parent belongs to another grounds');
      }
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
      const page = this.eventsAfter(Number(n), 100);
      return ok({ events: page.events, cursor: page.cursor });
    }
    const parts = c.path.split('/');
    if (parts[0] === 'documents' && parts[2] === 'files' && !parts[3] && c.method === 'POST') {
      const scope = this.glass.uploadScope(c, actor, now); return this.reserveFile(c, b, scope);
    }
    const cards = this.cards.execute(c, actor, now); if (cards) return cards;
    const glass = this.glass.execute(c, actor, now); if (glass) return glass;
    if (parts[0] === 'dispatches' && parts[1]) {
      const d = this.dispatch(identifier(parts[1])); const action = parts[2];
      requireThat(actor.kind !== 'dispatch' || actor.id === d.id, 403, 'dispatch scope required');
      if (!action && c.method === 'GET') return ok(this.view(d));
      if (action === 'cancel' && c.method === 'POST') {
        // The owner can stop work even with no helm online; this never changes its seat.
        if (actor.kind !== 'person') this.helm(c, actor, now);
        this.ctx.storage.sql.exec("UPDATE dispatches SET state='cancelled',hash=NULL,epoch=epoch+1 WHERE id=?", d.id);
        this.event('cancelled', d.id, `cancelled by ${actor.kind}:${actor.id}`); this.stopAssistanceChildren(d.id); return ok();
      }
      if (action === 'detail' && c.method === 'GET') {
        this.requirePermission(actor, 'read');
        return ok({ ...this.view(d), reports: this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM reports WHERE dispatch=? ORDER BY seq DESC LIMIT 100', d.id).toArray().reverse().map((r) => JSON.parse(r.data)),
          messages: this.ctx.storage.sql.exec('SELECT id,text,received FROM messages WHERE dispatch=? ORDER BY id DESC LIMIT 100', d.id).toArray().reverse(),
          files: this.ctx.storage.sql.exec('SELECT id,name,size FROM files WHERE dispatch=? AND ready=1 LIMIT 100', d.id).toArray() });
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
        const target = (JSON.parse(d.data) as DispatchInput).target;
        if (target) requireThat(!report.evidence?.prUrls?.length && !report.evidence?.commits?.length, 400, 'configured results accept files, not PR or commit evidence');
        if (report.verb === 'done') requireThat(!this.ctx.storage.sql.exec('SELECT id FROM messages WHERE dispatch=? AND received=0', d.id).toArray().length, 409, 'unreceived messages; read and receipt before done');
        for (const file of report.evidence?.files ?? []) requireThat(this.ctx.storage.sql.exec('SELECT id FROM files WHERE id=? AND dispatch=? AND ready=1', file, d.id).toArray().length, 400, 'evidence file not uploaded to this dispatch');
        if (report.verb === 'paused' && !report.until) report.until = new Date(now + 86400_000).toISOString();
        this.ctx.storage.sql.exec('INSERT INTO reports(dispatch,data) VALUES (?,?)', d.id, JSON.stringify({ ...report, at: new Date(now).toISOString() }));
        this.ctx.storage.sql.exec('UPDATE dispatches SET state=?,lease=? WHERE id=?', ['done', 'failed'].includes(report.verb) ? 'done' : 'active', this.boatCanWork(d.boat) ? now + LEASE_MS : d.lease, d.id);
        this.event(report.verb, d.id);
        if (['done', 'failed'].includes(report.verb)) { this.relayAssistanceResult(d, report); this.stopAssistanceChildren(d.id); }
        if (report.verb === 'done') {
          const claim = this.ctx.storage.sql.exec<{ claim_helm: number }>('SELECT claim_helm FROM catch_context WHERE dispatch=?', d.id).toArray()[0];
          // A claim made before this observation existed remains unknown unless a helm is live now.
          const withHelm = this.helmLive(now) || claim?.claim_helm === 1 ? true : claim ? false : null;
          return ok({ catch: { withHelm, at: new Date(now).toISOString() } });
        }
        return ok();
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
        const f = this.ctx.storage.sql.exec<FileRow>(`SELECT f.* FROM files f LEFT JOIN dispatches child ON child.id=f.dispatch WHERE f.id=? AND f.ready=1
          AND (f.dispatch=? OR (child.state='done' AND json_extract(child.data,'$.target.parentDispatch')=?))`, identifier(parts[3]), d.id, d.id).toArray()[0];
        requireThat(f, 404, 'file not found'); return ok(f);
      }
      if (action === 'files' && c.method === 'POST') {
        // Used only by upload(), which bounds and hashes the actual bytes.
        requireThat(actor.kind === 'dispatch' && d.state === 'active' && c.prepared?.id, 403, 'active dispatch token required');
        return this.reserveFile(c, b, d.id);
      }
    }
    throw new ApiError(404, 'route not found');
  }
  private reserveFile(c: Command, b: Record<string, unknown>, scope: string): StoredResult {
    requireThat(c.prepared?.id, 403, 'prepared upload required');
    const name = text(b.name, 128); requireThat(!/[\x00-\x1f/\\]/.test(name), 400, 'invalid file name');
    requireThat(typeof b.size === 'number' && Number.isInteger(b.size) && b.size >= 0 && b.size <= Number(this.env.MAX_FILE_BYTES), 413, 'file too large');
    const sum = this.ctx.storage.sql.exec<{ n: number }>('SELECT coalesce(sum(size),0) AS n FROM files').one().n;
    requireThat(sum + b.size + this.ctx.storage.sql.databaseSize <= Number(this.env.MAX_ACCOUNT_BYTES), 507, 'account storage limit');
    this.ctx.storage.sql.exec('INSERT INTO files(id,dispatch,name,size,hash) VALUES (?,?,?,?,?)', c.prepared.id, scope, name, b.size, c.prepared.hash);
    return { status: 200, value: { id: c.prepared.id } };
  }
  /** Child results can reach only their stored parent, once, inside the report transaction. */
  private relayAssistanceResult(child: DispatchRow, report: ReportInput): void {
    const target = (JSON.parse(child.data) as DispatchInput).target;
    if (!target?.parentDispatch || this.ctx.storage.sql.exec('SELECT child FROM assistance_results WHERE child=?', child.id).toArray().length) return;
    const parent = this.dispatch(target.parentDispatch);
    this.ctx.storage.sql.exec('INSERT INTO assistance_results VALUES (?,?)', child.id, parent.id);
    if (!['queued', 'active'].includes(parent.state)) { this.event('assistance-retained', child.id, `Parent ${parent.id} has ended; its result is retained`); return; }
    const files = report.evidence?.files ?? [];
    const note = `Assistance ${child.id} ${report.verb}: ${(report.note ?? '').slice(0, 8000)}${files.length ? `\nResult files: ${files.join(', ')}` : ''}\nContinue the original dispatch; it keeps repo and PR ownership.`;
    this.ctx.storage.sql.exec('INSERT INTO messages(dispatch,text) VALUES (?,?)', parent.id, note);
    this.event('message', parent.id);
  }

  /** End queued assistance and ask active children to stop without reopening the original catch. */
  private stopAssistanceChildren(parent: string): void {
    for (const child of this.ctx.storage.sql.exec<DispatchRow>(`SELECT * FROM dispatches WHERE state IN ('queued','active') AND json_extract(data,'$.target.parentDispatch')=?`, parent).toArray()) {
      if (child.state === 'queued') { this.ctx.storage.sql.exec("UPDATE dispatches SET state='cancelled' WHERE id=?", child.id); this.event('cancelled', child.id); }
      else if (!this.ctx.storage.sql.exec('SELECT child FROM assistance_stops WHERE child=?', child.id).toArray().length) {
        this.ctx.storage.sql.exec('INSERT INTO assistance_stops VALUES (?)', child.id);
        this.ctx.storage.sql.exec('INSERT INTO messages(dispatch,text) VALUES (?,?)', child.id, `Parent ${parent} has ended. Stop this assistance step and report failed with any findings already collected.`);
        this.event('message', child.id);
      }
    }
  }

  private worker(value: unknown, boat: string): WorkerRow {
    const id = identifier(value);
    const configured = this.ctx.storage.sql.exec<{ id: string; boat: string; target: string; seen: number }>('SELECT * FROM configured_workers WHERE id=?', id).toArray()[0];
    const w = configured ? { ...configured, target: configuredTarget(JSON.parse(configured.target)) } : this.ctx.storage.sql.exec<{ id: string; boat: string; repo: string; seen: number }>('SELECT * FROM workers WHERE id=?', id).toArray()[0];
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
  /** Delete what a mirror operation left in R2, after its transaction, in the R2 serial queue. */
  private dropMirrorFiles(cleanup: MirrorCleanup) {
    if (cleanup.keys.length) this.ctx.waitUntil(this.serialFile(() => this.env.FILES.delete(cleanup.keys)).catch(() => {}));
  }
  /**
   * Tell mirror boats something through their wake sockets: a call waits, a
   * hosted glass is open, or another boat's walking list changed (only to
   * boats granted attention, never to the boat that put it). No content travels.
   */
  private async mirrorHint(boats: ReadonlySet<string> | 'all' | { except: string },
    message: { type: 'mirror-call' } | { type: 'mirror-watch'; until: string } | { type: 'attention' }) {
    const needs: Permission = message.type === 'attention' ? 'attention' : 'mirror';
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const a = socket.deserializeAttachment() as { actor: Actor; hash: string };
        if (a.actor.kind !== 'boat') continue;
        if (boats instanceof Set ? !boats.has(a.actor.id) : boats !== 'all' && a.actor.id === (boats as { except: string }).except) continue;
        const row = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', a.actor.id).toArray()[0];
        const grants = this.ctx.storage.sql.exec<{ permissions: string }>('SELECT permissions FROM boat_permissions WHERE boat=?', a.actor.id).toArray()[0];
        if (!this.get('deleted') && row && !row.revoked && sameHash(row.hash, a.hash) && permits(grants ? JSON.parse(grants.permissions) : ['work'], needs)) socket.send(JSON.stringify(message));
      } catch { /* disconnected */ }
    }
  }
  /**
   * The mirror's own rate budget, apart from the account's: a hosted glass
   * polling a mirror boat must never starve the fleet's coordination.
   */
  private mirrorBudget(now: number) { this.spend('mirror', 4 * Number(this.env.REQUESTS_PER_MINUTE), now, 'mirror rate limit'); }
  /**
   * Every mirror route. Mirror operations keep no idempotency records: a
   * put replaces the boat's latest snapshot, and a take or an answer
   * succeeds once. `bytes` is a put's gzip, an answer's body or an uploaded
   * file; `meta` is what the request's headers said about it.
   */
  async mirror(command: string, bytes?: Uint8Array, meta: { status?: number; contentType?: string; name?: string; boat?: string } = {}): Promise<string> {
    // A call made or answered moves when the next one expires.
    return this.serialFile(() => this.mirrorRoute(command, bytes, meta)).finally(() => this.scheduleAlarm());
  }
  private async mirrorRoute(command: string, bytes: Uint8Array | undefined, meta: { status?: number; contentType?: string; name?: string; boat?: string }): Promise<string> {
    {
      const c: Command = JSON.parse(command);
      try {
        // A catch's own credential reaches its dispatch only, never a boat's mirror.
        requireThat(!c.token.startsWith('d.'), 403, 'mirror routes take a mirror boat credential or a signed-in person');
        const hash = await digest(c.token.startsWith('b.') ? c.token.split('.').at(-1)! : c.token);
        // A put, an answer or a file runs more than one transaction; the request counts once.
        let counted = false;
        const run = <T>(fn: (actor: Actor, now: number) => T): T => {
          let cleanup: MirrorCleanup = { keys: [] };
          const result = this.ctx.storage.transactionSync(() => {
            const now = Date.now();
            requireThat(!this.get('deleted'), 410, 'account deleted');
            const actor = this.authenticate(c, hash, now);
            if (!counted) { this.mirrorBudget(now); counted = true; }
            this.authorize(c, actor);
            cleanup = this.mirrorState.expire(c.account, now);
            return fn(actor, now);
          });
          this.dropMirrorFiles(cleanup);
          return result;
        };
        if (c.path === 'mirror/snapshot' && c.method === 'PUT') {
          run((actor) => this.mirrorState.authorizeSnapshot(actor));
          const json = await gunzipText(bytes ?? new Uint8Array(), MIRROR_SNAPSHOT_MAX_JSON_BYTES);
          let snapshot: unknown;
          try { snapshot = JSON.parse(json); } catch { throw new ApiError(400, 'the snapshot is not JSON'); }
          requireThat(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 400, 'the snapshot is not a glass snapshot');
          // The page token opens the boat's own glass for writes; it never leaves the boat.
          requireThat(!('focusToken' in (snapshot as object)), 400, 'a mirrored snapshot never carries the page token');
          const etag = await digest(json);
          const actor = run((a) => a);
          await this.env.FILES.put(mirrorSnapshotKey(c.account, actor.id), bytes!, { customMetadata: { etag } });
          const recorded = run((a, now) => this.mirrorState.recordSnapshot(a, etag, bytes!.byteLength, now));
          // Every open glass tab gets the bytes the boat put: it shows them with no request.
          if (recorded.status === 200) {
            const boat = this.ctx.storage.sql.exec<BoatRow>('SELECT * FROM boats WHERE id=?', actor.id).one();
            this.ctx.waitUntil(this.pushFrame({ t: 'snapshot', boat: actor.id, name: boat.name, at: new Date().toISOString(), etag }, bytes!));
          }
          return JSON.stringify(recorded);
        }
        // A boat's walking list: kept when it changed, and the boats granted attention are told.
        if (c.path === 'mirror/attention' && c.method === 'PUT') {
          const json = attentionJson(c.body);
          const etag = await digest(json);
          const put = run((actor, now) => {
            const r = this.mirrorState.putAttention(actor, json, etag, now);
            return { ...r, boat: actor.id };
          });
          if (put.changed) this.ctx.waitUntil(this.mirrorHint({ except: put.boat }, { type: 'attention' }));
          return JSON.stringify({ status: put.status, value: put.value });
        }
        const answer = /^mirror\/calls\/([A-Za-z0-9_-]+)\/answer$/.exec(c.path);
        if (answer && c.method === 'POST') {
          const id = answer[1]!;
          run((actor, now) => this.mirrorState.authorizeAnswer(actor, id, now));
          const status = Number(meta.status);
          requireThat(Number.isInteger(status) && status >= 200 && status <= 599, 400, 'invalid answer status');
          const contentType = text(meta.contentType ?? 'application/octet-stream', 200);
          await this.env.FILES.put(mirrorAnswerKey(c.account, id), bytes ?? new Uint8Array(), { httpMetadata: { contentType } });
          const recorded = run((actor, now) => this.mirrorState.recordAnswer(actor, id, { status, contentType, bytes: bytes?.byteLength ?? 0 }, now));
          if (recorded.status === 200) {
            // The tab that asked gets the answer in its frame; one too large to push is read over HTTP.
            const body = bytes ?? new Uint8Array();
            const large = body.byteLength > ANSWER_INLINE_MAX_BYTES;
            this.ctx.waitUntil(this.pushFrame({ t: 'answer', id, status, contentType, ...(large ? { large: true as const } : {}) }, large ? undefined : body));
            for (const release of this.answerWaiters.get(id) ?? []) release();
          }
          return JSON.stringify(recorded);
        }
        if (c.path === 'mirror/files' && c.method === 'POST') {
          const boat = identifier(meta.boat), name = text(meta.name ?? 'attachment', 200);
          requireThat(!/[\x00-\x1f/\\]/.test(name) && name !== '.' && name !== '..', 400, 'invalid file name');
          run((actor) => this.mirrorState.authorizeFile(actor, boat));
          const id = crypto.randomUUID();
          await this.env.FILES.put(mirrorFileKey(c.account, id), bytes ?? new Uint8Array(), { httpMetadata: { contentType: 'application/octet-stream', contentDisposition: 'attachment' } });
          return JSON.stringify(run((actor, now) => this.mirrorState.recordFile(actor, boat, id, name, bytes?.byteLength ?? 0, now)));
        }
        const result = run((actor, now) => {
          const r = this.mirrorState.execute(c, actor, now, c.account);
          if (r.watch) {
            const watched = this.mirrorWatchedUntil > now;
            this.mirrorWatchedUntil = now + MIRROR_WATCH_MS;
            if (!watched) this.ctx.waitUntil(this.mirrorHint('all', { type: 'mirror-watch', until: new Date(now + MIRROR_WATCH_MS).toISOString() }));
          }
          if (r.hint) this.ctx.waitUntil(this.mirrorHint(new Set([r.hint]), { type: 'mirror-call' }));
          // A boat's call list says whether a hosted glass is open, so it knows how often to put.
          if (c.path === 'mirror/calls' && c.method === 'GET' && r.status === 200) {
            // A glass tab with its socket open watches for as long as it stays connected.
            if (this.ctx.getWebSockets('glass').length) this.mirrorWatchedUntil = Math.max(this.mirrorWatchedUntil, now + MIRROR_WATCH_MS);
            const until = this.mirrorWatchedUntil;
            return { status: r.status, value: { ...(r.value as object), ...(until > now ? { watchedUntil: new Date(until).toISOString() } : {}) } };
          }
          return { status: r.status, value: r.value };
        });
        return JSON.stringify(result);
      } catch (e) {
        if (e instanceof ApiError) return JSON.stringify({ status: e.status, value: { error: e.message } });
        throw e;
      }
    }
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
        const reserve = await this.command(c); if (reserve.status !== 200) return JSON.stringify(reserve);
        const file = identifier(object(reserve.value).id);
        const row = this.ctx.storage.sql.exec<FileRow>('SELECT * FROM files WHERE id=?', file).one();
        if (!row.ready) {
          await this.env.FILES.put(`${c.account}/${file}`, bytes, { sha256: hash, httpMetadata: { contentType: 'application/octet-stream', contentDisposition: 'attachment' } });
          // SQL tombstones cannot race deletion: deleteAccount uses this same
          // R2 serial queue, and all metadata remains durable across eviction.
          this.ctx.storage.sql.exec('UPDATE files SET ready=1 WHERE id=?', file);
          if (!this.glass.isReviewScope(row.dispatch)) this.event('file-uploaded', row.dispatch);
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
        for (const socket of this.ctx.getWebSockets()) socket.close(1008, 'account deleted');
        await this.ctx.storage.deleteAlarm();
        for (;;) {
          const files = await this.env.FILES.list({ prefix: `${c.account}/`, limit: 1000 });
          if (!files.objects.length) break;
          await this.env.FILES.delete(files.objects.map((f) => f.key));
        }
        this.ctx.storage.transactionSync(() => {
          for (const table of ['boats', 'boat_permissions', 'workers', 'configured_workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'catch_context', 'messages', 'assistance_results', 'assistance_stops', 'files', ...glassTables, ...mirrorTables]) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
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

/** Send one protocol message on a socket. */
function send(socket: WebSocket, message: ServerSocketMessage) { socket.send(JSON.stringify(message)); }

/** Whether a command came from a glass tab's cookie, not a person's CLI bearer. */
function isGlass(c: Command): boolean { return c.token.startsWith('browser:'); }

/**
 * A socket's tags: what it is (a boat, a glass tab, a person's CLI) and
 * which one, so later pushes can address one kind or one client.
 */
function socketTags(actor: Actor, c: Command): string[] {
  if (actor.kind === 'boat') return ['boat', `boat:${actor.id}`];
  return [isGlass(c) ? 'glass' : 'person', ...(c.personSessionId ? [`session:${c.personSessionId}`] : [])];
}

/**
 * A credential's name without its secret: a boat's or a dispatch's token
 * keeps its kind, account and id, which is all authentication reads beside
 * the hash; any other token (a person's session) is not kept at all.
 */
function credentialName(token: string): string {
  const pieces = token.split('.');
  if (pieces[0] === 'b') return `b.${pieces[1]}.${pieces[2]}.-`;
  if (token.startsWith('browser:')) return token;
  return 'person';
}

/** Unpack a gzip body as text, refusing more than `max` bytes of it. */
async function gunzipText(bytes: Uint8Array, max: number): Promise<string> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength; requireThat(n <= max, 413, 'snapshot too large once unpacked'); chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'the snapshot is not gzip');
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(n); let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(out);
}
