import type { GlassCard, GlassCardAction, GlassCardFamily } from '../../../packages/core/src/backend-model.js';
import { digest } from './protocol.js';
import { renderCard, renderRepost } from './slack-render.js';
import type { CardControl } from './slack-render.js';
import { SlackApi } from './slack-api.js';
import type { SlackOutcome } from './slack-api.js';

/**
 * `slack_links`: whose private chat with the app shows their cards, by wharf
 * person; a live link gets every card on the account, from every boat and
 * grounds, in the kind groups it keeps on. `slack_deliveries`: one row per
 * card and person. `want` counts the card's changes; `sent` is the count the
 * last successful post or edit showed, so a delivery is due while
 * `want > sent`. `ts` is the message that card lives in, edited in place
 * from then on.
 * `slack_reposts`: the new messages a Slack request's thread is owed when
 * its glass thread changes, one row per request and kind: `update` (`seq`
 * is the newest boat update heard), or `dispatch:<id>`, once per dispatch.
 * They hold no message text: each post is a canned line and a glass link.
 * `slack_link_kinds`: the kind groups a person turned off; with none, every
 * kind is sent, so a group added later starts on.
 */
export const slackSchema = `
  CREATE TABLE IF NOT EXISTS slack_links (person TEXT PRIMARY KEY, team TEXT NOT NULL, user TEXT NOT NULL, channel TEXT NOT NULL, linked_at TEXT NOT NULL, revoked_at TEXT);
  DROP TABLE IF EXISTS slack_link_grounds;
  CREATE TABLE IF NOT EXISTS slack_link_kinds (person TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(person, kind));
  CREATE TABLE IF NOT EXISTS slack_deliveries (card INTEGER NOT NULL, person TEXT NOT NULL, want INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, ts TEXT, sent_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, PRIMARY KEY(card, person));
  CREATE TABLE IF NOT EXISTS slack_actions (handle TEXT PRIMARY KEY, person TEXT NOT NULL, card INTEGER NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS slack_action_card ON slack_actions(person, card, revision);
  CREATE TABLE IF NOT EXISTS slack_reposts (request TEXT NOT NULL, key TEXT NOT NULL, want INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, PRIMARY KEY(request, key));
`;
export const slackTables = ['slack_links', 'slack_link_kinds', 'slack_deliveries', 'slack_actions', 'slack_reposts'];
/** The groups of card kinds a person can turn off for Slack. */
export const SLACK_KINDS = ['decisions', 'permissions', 'prs', 'jobs', 'notices'] as const;
export type SlackKind = (typeof SLACK_KINDS)[number];
/** Each card family's group. A request's receipt answers the person's own DM, so it has none and is always sent. */
const KIND_OF: Record<Exclude<GlassCardFamily, 'request'>, SlackKind> = {
  decision: 'decisions', question: 'decisions', permission: 'permissions', pr: 'prs', review: 'prs', stack: 'prs',
  dispatch: 'jobs', landed: 'jobs', report: 'jobs', notice: 'notices', trap: 'notices', boat: 'notices',
};
const kindOf = (card: GlassCard): SlackKind | undefined => (card.family === 'request' ? undefined : KIND_OF[card.family]);
/** A sent repost is kept past its request's seven days, so a late duplicate of it still finds it. */
const REPOST_KEEP_MS = 8 * 86400_000;
/** A button's handle is good this long: past it, the click asks the person to open the card again. */
export const ACTION_HANDLE_MS = 86400_000;
/** At most this many Slack calls per drain; the next command drains the rest. */
export const DRAIN_CALLS = 20;
/** Slack allows about one message a second in a conversation. */
export const CONVERSATION_SPACING_MS = 1100;
/** Never: a refused delivery waits for its person to link again. */
const NEVER = Number.MAX_SAFE_INTEGER;

type Delivery = { card: number; person: string; want: number; sent: number; ts: string | null; sent_hash: string | null; attempts: number; next_at: number; error: string | null };
type Repost = { request: string; key: string; want: number; sent: number; seq: number; attempts: number; next_at: number; error: string | null };
type Link = { person: string; team: string; user: string; channel: string; revoked_at: string | null };
/** The Slack thread a request came from, and the glass page its updates open. */
export interface RepostTarget {
  person: string;
  channel: string;
  /** The person's message that asked: reposts reply under it. */
  threadTs: string;
  /** What the person asked, for the notification's text. */
  title: string;
  /** The request's glass thread, as a glass path: `#thread/<id>`, or its card's. */
  open: string;
}
export interface OutboxDeps {
  /** The glass every message links back to. */
  glassOrigin: string;
  /** The card a delivery shows, by its stored sequence. */
  card(seq: number): GlassCard | undefined;
  /** The bot token for a workspace, or nothing while the app is not installed there. */
  token(team: string): Promise<string | undefined>;
  /** The actions a card offers that can be taken from its Slack message. */
  controllable(card: GlassCard): GlassCardAction[];
  /** The boat a card names on its context line: a boat card's own boat, or nothing. */
  boat?(card: GlassCard): string | undefined;
  /** The thread a card's first post replies in, in that conversation, when it belongs to one. */
  thread?(card: GlassCard, channel: string): string | undefined;
  /** Where a Slack request's reposts go, or nothing once the request is gone. */
  repostTarget?(request: string): RepostTarget | undefined;
  /** How a drain waits between calls to one conversation. */
  pause?: (ms: number) => Promise<void>;
}
const seqOf = (card: GlassCard) => Number(card.id.slice(1));
/** A failed call waits longer each time, up to ten minutes. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** attempts, 600_000);

/**
 * Carries each card into its linked person's private chat, one message per
 * card, edited as the card changes. The card is the authority: a delivery
 * only ever retries the projection of it, never the answer or action that
 * changed it.
 */
export class SlackOutbox {
  private running?: Promise<void>;
  constructor(private sql: SqlStorage, private deps: OutboxDeps) {}
  /** Whether the person's link is live: it serves every card on the account in the kind groups they keep on, whatever its grounds or boat. */
  serves(person: string): boolean {
    return this.sql.exec('SELECT 1 FROM slack_links WHERE person=? AND revoked_at IS NULL', person).toArray().length > 0;
  }
  /**
   * Inside the transaction that changed the cards: each linked person's
   * delivery of each card falls due. A card that ended before it was ever
   * shown is not posted.
   */
  mark(cards: GlassCard[], now: number, only?: string) {
    const people = this.sql.exec<{ person: string }>('SELECT person FROM slack_links WHERE revoked_at IS NULL').toArray().filter((p) => !only || p.person === only);
    if (!people.length) return;
    const off = new Map<string, Set<string>>();
    for (const row of this.sql.exec<{ person: string; kind: string }>('SELECT person, kind FROM slack_link_kinds').toArray()) off.set(row.person, (off.get(row.person) ?? new Set()).add(row.kind));
    for (const card of cards) for (const { person } of people) {
      const kind = kindOf(card);
      if (kind && off.get(person)?.has(kind)) continue;
      const seq = seqOf(card);
      const updated = this.sql.exec(`UPDATE slack_deliveries SET want=want+1, next_at=CASE WHEN next_at=? THEN next_at ELSE min(next_at,?) END WHERE card=? AND person=?`, NEVER, now, seq, person).rowsWritten;
      if (!updated && !card.terminal) this.sql.exec('INSERT INTO slack_deliveries(card,person,want,next_at) VALUES (?,?,1,?)', seq, person, now);
    }
  }
  /**
   * A person's link as it now stands. A new link shows them every standing
   * card; one in another conversation starts over there, since the old
   * messages cannot be edited from it. Unlinking stops their deliveries.
   */
  link(person: string, link: { team: string; slackUser: string; channel: string; linkedAt: string } | null, standing: GlassCard[], now: number) {
    this.sql.exec('DELETE FROM slack_actions WHERE person=?', person);
    if (!link) { this.sql.exec('UPDATE slack_links SET revoked_at=? WHERE person=? AND revoked_at IS NULL', new Date(now).toISOString(), person); return; }
    const before = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', person).toArray()[0];
    if (before && before.channel !== link.channel) this.sql.exec('DELETE FROM slack_deliveries WHERE person=?', person);
    else this.sql.exec('UPDATE slack_deliveries SET next_at=?, error=NULL, attempts=0 WHERE person=?', now, person);
    this.sql.exec('UPDATE slack_reposts SET next_at=?, error=NULL, attempts=0 WHERE want>sent', now);
    this.sql.exec('INSERT OR REPLACE INTO slack_links VALUES (?,?,?,?,?,NULL)', person, link.team, link.slackUser, link.channel, link.linkedAt);
    this.mark(standing, now, person);
  }
  /** The kind groups a person's Slack gets. */
  kinds(person: string): SlackKind[] {
    const off = new Set(this.sql.exec<{ kind: string }>('SELECT kind FROM slack_link_kinds WHERE person=?', person).toArray().map((r) => r.kind));
    return SLACK_KINDS.filter((kind) => !off.has(kind));
  }
  /** Whether a person's Slack gets this card: its group is on, or it is a request's receipt. */
  private wants(person: string, card: GlassCard): boolean {
    const kind = kindOf(card);
    return !kind || !this.sql.exec('SELECT 1 FROM slack_link_kinds WHERE person=? AND kind=?', person, kind).toArray().length;
  }
  /**
   * Set the kind groups a person's Slack gets. A group turned off drops what
   * was waiting to go out; its messages already in Slack stay as they are. A
   * group turned on shows its standing cards, as linking does.
   */
  setKinds(person: string, on: SlackKind[], standing: GlassCard[], now: number) {
    const before = this.kinds(person);
    this.sql.exec('DELETE FROM slack_link_kinds WHERE person=?', person);
    for (const kind of SLACK_KINDS) if (!on.includes(kind)) this.sql.exec('INSERT INTO slack_link_kinds VALUES (?,?)', person, kind);
    const pending = this.sql.exec<Delivery>('SELECT * FROM slack_deliveries WHERE person=? AND want>sent', person).toArray();
    for (const job of pending) {
      const card = this.deps.card(job.card);
      if (card && !this.wants(person, card)) this.drop(job);
    }
    const added = on.filter((kind) => !before.includes(kind));
    this.mark(standing.filter((card) => added.includes(kindOf(card)!)), now, person);
  }
  /**
   * A delivery its person no longer wants. One never posted goes; one whose
   * message is in Slack keeps it, settled, so turning the group on again
   * edits that message instead of posting another.
   */
  private drop(job: Delivery) {
    if (job.ts) this.settle(job, { sent: job.want, error: null });
    else this.sql.exec('DELETE FROM slack_deliveries WHERE card=? AND person=?', job.card, job.person);
  }
  /**
   * The buttons a person's message of a card carries: one opaque handle per
   * action, bound here to that person, card, revision and exact action. A
   * handle still good for at least an hour is reused, so an unchanged card
   * renders the same message; an ended card carries none.
   */
  private controls(person: string, card: GlassCard, now: number): CardControl[] {
    if (card.terminal) return [];
    this.sql.exec('DELETE FROM slack_actions WHERE expires<?', now);
    const seq = seqOf(card);
    return this.deps.controllable(card).map((action) => {
      const key = JSON.stringify(action);
      const kept = this.sql.exec<{ handle: string }>('SELECT handle FROM slack_actions WHERE person=? AND card=? AND revision=? AND action=? AND expires>?',
        person, seq, card.revision, key, now + 3_600_000).toArray()[0];
      if (kept) return { action, handle: kept.handle };
      const handle = `h${crypto.randomUUID().replace(/-/g, '')}`;
      this.sql.exec('INSERT INTO slack_actions VALUES (?,?,?,?,?,?)', handle, person, seq, card.revision, key, now + ACTION_HANDLE_MS);
      return { action, handle };
    });
  }
  /**
   * What a pressed button names, checked: this person's handle, unexpired,
   * for the card's current revision. A click on an older message gets the
   * card as it now stands, never an action on a state it did not show.
   */
  pressed(person: string, handle: string, now: number): { card: GlassCard; action: GlassCardAction } | { refused: 'expired' | 'stale'; card?: GlassCard } {
    const row = this.sql.exec<{ person: string; card: number; revision: number; action: string; expires: number }>('SELECT * FROM slack_actions WHERE handle=?', handle).toArray()[0];
    if (!row || row.person !== person || row.expires <= now) return { refused: 'expired' };
    const card = this.deps.card(row.card);
    if (!this.serves(person)) return { refused: 'expired' };
    if (!card || card.revision !== row.revision || card.terminal) return { refused: 'stale', ...(card ? { card } : {}) };
    return { card, action: JSON.parse(row.action) };
  }
  /** Cards deleted from the store: their deliveries and buttons go too, inside the same transaction. */
  forget(cards: number[]) {
    for (const card of cards) {
      this.sql.exec('DELETE FROM slack_deliveries WHERE card=?', card);
      this.sql.exec('DELETE FROM slack_actions WHERE card=?', card);
    }
  }
  /** Show a person's card again, whatever their message of it last said. */
  refresh(person: string, card: GlassCard, now: number) {
    if (!this.serves(person) || !this.wants(person, card)) return;
    this.sql.exec('UPDATE slack_deliveries SET want=want+1, next_at=min(next_at,?) WHERE card=? AND person=? AND next_at<>?', now, seqOf(card), person, NEVER);
  }
  /**
   * Inside the transaction that changed a Slack request's glass thread: its
   * Slack thread is owed a new message. A dispatch not announced before gets
   * its own, and stands in for the update that linked it. A boat's update
   * names its sequence, so one heard twice posts once; updates that arrive
   * before the next drain go out as one.
   */
  repost(request: string, update: { seq?: number; dispatches?: string[] }, now: number) {
    const started = (update.dispatches ?? []).filter((id) =>
      this.sql.exec('INSERT OR IGNORE INTO slack_reposts(request,key,want,next_at) VALUES (?,?,1,?)', request, `dispatch:${id}`, now).rowsWritten > 0);
    const row = this.sql.exec<{ seq: number }>("SELECT seq FROM slack_reposts WHERE request=? AND key='update'", request).toArray()[0];
    if (update.seq !== undefined && row && update.seq <= row.seq) return;
    const want = started.length ? 0 : 1, seq = update.seq ?? 0;
    if (!row) this.sql.exec("INSERT INTO slack_reposts(request,key,want,seq,next_at) VALUES (?,'update',?,?,?)", request, want, seq, now);
    else this.sql.exec(`UPDATE slack_reposts SET want=want+?, seq=max(seq,?), next_at=CASE WHEN ?=0 OR next_at=? THEN next_at ELSE min(next_at,?) END
      WHERE request=? AND key='update'`, want, seq, want, NEVER, now, request);
  }
  /** When the next Slack delivery is due, a retry's backoff included; none when nothing waits to go out. */
  nextDue(): number | undefined {
    const row = this.sql.exec<{ at: number | null }>(`SELECT min(at) AS at FROM (SELECT min(next_at) AS at FROM slack_deliveries WHERE want>sent AND next_at<>?
      UNION ALL SELECT min(next_at) FROM slack_reposts WHERE want>sent AND next_at<>?)`, NEVER, NEVER).toArray()[0];
    return row?.at ?? undefined;
  }
  /** Whether a drain has anything to do now. */
  due(now: number): boolean {
    return this.sql.exec('SELECT 1 FROM slack_deliveries WHERE want>sent AND next_at<=? UNION ALL SELECT 1 FROM slack_reposts WHERE want>sent AND next_at<=? LIMIT 1', now, now).toArray().length > 0;
  }
  /** Send what is due, one call at a time. A drain already running is the one to wait on. */
  drain(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run() {
    const last = new Map<string, number>();
    this.sql.exec('DELETE FROM slack_reposts WHERE want<=sent AND next_at<?', Date.now() - REPOST_KEEP_MS);
    for (let calls = 0; calls < DRAIN_CALLS; ) {
      // Cards first: a request's receipt goes out before the updates under it.
      const job = this.sql.exec<Delivery>('SELECT * FROM slack_deliveries WHERE want>sent AND next_at<=? ORDER BY next_at, card LIMIT 1', Date.now()).toArray()[0];
      const repost = job ? undefined : this.sql.exec<Repost>('SELECT * FROM slack_reposts WHERE want>sent AND next_at<=? ORDER BY next_at, rowid LIMIT 1', Date.now()).toArray()[0];
      if (!job && !repost) return;
      try {
        if (job ? await this.deliver(job, last) : await this.repostOne(repost!, last)) calls++;
      } catch (e) {
        // One job that throws (an unsealable token, a render) waits its backoff; the rest still go.
        const name = e instanceof Error ? e.name : 'error';
        console.log(JSON.stringify({ slack: job ? 'delivery' : 'repost', ...(job ? { card: job.card } : {}), ok: false, outcome: 'failed', error: name }));
        const attempts = (job ?? repost!).attempts;
        const change = { attempts: attempts + 1, next_at: Date.now() + backoff(attempts), error: `failed: ${name}` };
        if (job) this.settle(job, change); else this.settleRepost(repost!, change);
      }
    }
  }
  /** Wait out Slack's spacing for one conversation. */
  private async spaced(channel: string, last: Map<string, number>) {
    const wait = (last.get(channel) ?? 0) + CONVERSATION_SPACING_MS - Date.now();
    if (wait > 0) await (this.deps.pause ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
  }
  /** Post one due repost as a new message in its request's Slack thread; true when it made a Slack call. */
  private async repostOne(job: Repost, last: Map<string, number>): Promise<boolean> {
    const target = this.deps.repostTarget?.(job.request);
    if (!target) { this.sql.exec('DELETE FROM slack_reposts WHERE request=? AND key=?', job.request, job.key); return false; }
    const live = (l: Link | undefined) => l && !l.revoked_at && l.channel === target.channel;
    const link = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', target.person).toArray()[0];
    if (!live(link)) { this.settleRepost(job, { next_at: NEVER, error: 'unlinked' }); return false; }
    const token = await this.deps.token(link!.team);
    if (!token) { this.settleRepost(job, { next_at: Date.now() + 300_000, error: 'not installed' }); return false; }
    const dispatch = job.key.startsWith('dispatch:') ? job.key.slice('dispatch:'.length) : undefined;
    const message = renderRepost(dispatch ? 'dispatch' : 'update', target.title, `${this.deps.glassOrigin}/${dispatch ? `#job/${dispatch}` : target.open}`);
    await this.spaced(link!.channel, last);
    // Unlinking may happen while fetching the installation or waiting for Slack's rate limit.
    if (!live(this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', target.person).toArray()[0])) return false;
    const outcome = await new SlackApi(token).post(link!.channel, message, target.threadTs);
    last.set(link!.channel, Date.now());
    const now = Date.now();
    if (outcome.kind === 'sent') this.settleRepost(job, { sent: job.want, attempts: 0, next_at: now, error: null });
    else if (outcome.kind === 'refused') this.settleRepost(job, { next_at: NEVER, error: `refused: ${outcome.reason}` });
    else if (outcome.kind === 'later') this.settleRepost(job, { attempts: job.attempts + 1, next_at: now + outcome.afterMs, error: outcome.reason });
    // Unknown, or gone (which a new post cannot be): try again. A post that did land shows the same link twice.
    else this.settleRepost(job, { attempts: job.attempts + 1, next_at: now + backoff(job.attempts), error: outcome.kind === 'unknown' ? outcome.reason : 'gone' });
    return true;
  }
  /** Write a repost's result. As with a delivery, `sent` only rises to the count this post showed. */
  private settleRepost(job: Repost, change: Partial<Pick<Repost, 'sent' | 'attempts' | 'next_at' | 'error'>>) {
    const fields = Object.keys(change) as Array<keyof typeof change>;
    const sets = fields.map((f) => (f === 'sent' ? 'sent=max(sent,?)' : `${f}=?`)).join(',');
    this.sql.exec(`UPDATE slack_reposts SET ${sets} WHERE request=? AND key=?`, ...fields.map((f) => change[f] ?? null), job.request, job.key);
  }
  /** Settle one due delivery; true when it made a Slack call. */
  private async deliver(job: Delivery, last: Map<string, number>): Promise<boolean> {
    const link = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', job.person).toArray()[0];
    const card = this.deps.card(job.card);
    if (!card) { this.sql.exec('DELETE FROM slack_deliveries WHERE card=? AND person=?', job.card, job.person); return false; }
    if (!link || link.revoked_at) { this.settle(job, { next_at: NEVER, error: 'unlinked' }); return false; }
    if (!this.wants(job.person, card)) { this.drop(job); return false; }
    // Not posted yet and already ended: there is nothing left to show or close.
    if (!job.ts && card.terminal) { this.settle(job, { sent: job.want, error: null }); return false; }
    const token = await this.deps.token(link.team);
    if (!token) { this.settle(job, { next_at: Date.now() + 300_000, error: 'not installed' }); return false; }
    const message = renderCard(card, this.deps.glassOrigin, this.controls(job.person, card, Date.now()), this.deps.boat?.(card));
    const hash = await digest(JSON.stringify(message));
    if (job.ts && hash === job.sent_hash) { this.settle(job, { sent: job.want, error: null }); return false; }
    await this.spaced(link.channel, last);
    // Unlinking, relinking or turning the card's group off may happen while fetching the installation or waiting for Slack's rate limit.
    if (!this.serves(job.person) || !this.wants(job.person, card)) return false;
    const currentLink = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', job.person).toArray()[0];
    if (!currentLink || currentLink.channel !== link.channel || currentLink.team !== link.team || currentLink.user !== link.user) return false;
    if (!this.deps.card(job.card)) return false;
    const api = new SlackApi(token);
    const outcome = job.ts ? await api.update(link.channel, job.ts, message) : await api.post(link.channel, message, this.deps.thread?.(card, link.channel));
    last.set(link.channel, Date.now());
    this.record(job, outcome, hash);
    return true;
  }
  private record(job: Delivery, outcome: SlackOutcome, hash: string) {
    const now = Date.now();
    // A post names the card's message; an edit never changes which message that is.
    if (outcome.kind === 'sent') this.settle(job, { sent: job.want, ts: job.ts ?? outcome.ts, sent_hash: hash, attempts: 0, next_at: now, error: null });
    // The message is gone: post the card again as a new message.
    else if (outcome.kind === 'gone') this.settle(job, { ts: null, sent_hash: null, next_at: now, error: 'message gone' });
    else if (outcome.kind === 'refused') this.settle(job, { next_at: NEVER, error: `refused: ${outcome.reason}` });
    else if (outcome.kind === 'later') this.settle(job, { attempts: job.attempts + 1, next_at: now + outcome.afterMs, error: outcome.reason });
    // An unknown post may have landed. Posting again can show the card twice;
    // both show the same card, and neither can answer it twice.
    else this.settle(job, { attempts: job.attempts + 1, next_at: now + backoff(job.attempts), error: outcome.reason });
  }
  /**
   * Write a delivery's result. `sent` only ever rises to the count this call
   * rendered: a change that arrived while it was in flight stays due.
   */
  private settle(job: Delivery, change: Partial<Omit<Delivery, 'card' | 'person' | 'want'>>) {
    const fields = Object.keys(change) as Array<keyof typeof change>;
    const sets = fields.map((f) => (f === 'sent' ? 'sent=max(sent,?)' : `${f}=?`)).join(',');
    this.sql.exec(`UPDATE slack_deliveries SET ${sets} WHERE card=? AND person=?`, ...fields.map((f) => change[f] ?? null), job.card, job.person);
  }
}
