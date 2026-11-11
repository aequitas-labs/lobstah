import type { GlassCard } from '../../../packages/core/src/backend-model.js';
import { digest } from './protocol.js';
import { renderCard } from './slack-render.js';
import { SlackApi } from './slack-api.js';
import type { SlackOutcome } from './slack-api.js';

/**
 * `slack_links`: whose private chat with the app shows their cards, by wharf
 * person. `slack_deliveries`: one row per card and person. `want` counts the
 * card's changes; `sent` is the count the last successful post or edit
 * showed, so a delivery is due while `want > sent`. `ts` is the message
 * that card lives in, edited in place from then on.
 */
export const slackSchema = `
  CREATE TABLE IF NOT EXISTS slack_links (person TEXT PRIMARY KEY, team TEXT NOT NULL, user TEXT NOT NULL, channel TEXT NOT NULL, linked_at TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS slack_deliveries (card INTEGER NOT NULL, person TEXT NOT NULL, want INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, ts TEXT, sent_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, PRIMARY KEY(card, person));
`;
export const slackTables = ['slack_links', 'slack_deliveries'];
/** At most this many Slack calls per drain; the next command drains the rest. */
export const DRAIN_CALLS = 20;
/** Slack allows about one message a second in a conversation. */
export const CONVERSATION_SPACING_MS = 1100;
/** Never: a refused delivery waits for its person to link again. */
const NEVER = Number.MAX_SAFE_INTEGER;

type Delivery = { card: number; person: string; want: number; sent: number; ts: string | null; sent_hash: string | null; attempts: number; next_at: number; error: string | null };
type Link = { person: string; team: string; user: string; channel: string; revoked_at: string | null };
export interface OutboxDeps {
  /** The glass every message links back to. */
  glassOrigin: string;
  /** The card a delivery shows, by its stored sequence. */
  card(seq: number): GlassCard | undefined;
  /** The bot token for a workspace, or nothing while the app is not installed there. */
  token(team: string): Promise<string | undefined>;
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
  /**
   * Inside the transaction that changed the cards: each linked person's
   * delivery of each card falls due. A card that ended before it was ever
   * shown is not posted.
   */
  mark(cards: GlassCard[], now: number, only?: string) {
    const people = this.sql.exec<{ person: string }>('SELECT person FROM slack_links WHERE revoked_at IS NULL').toArray().filter((p) => !only || p.person === only);
    if (!people.length) return;
    for (const card of cards) for (const { person } of people) {
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
    if (!link) { this.sql.exec('UPDATE slack_links SET revoked_at=? WHERE person=? AND revoked_at IS NULL', new Date(now).toISOString(), person); return; }
    const before = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', person).toArray()[0];
    if (before && before.channel !== link.channel) this.sql.exec('DELETE FROM slack_deliveries WHERE person=?', person);
    else this.sql.exec('UPDATE slack_deliveries SET next_at=?, error=NULL, attempts=0 WHERE person=?', now, person);
    this.sql.exec('INSERT OR REPLACE INTO slack_links VALUES (?,?,?,?,?,NULL)', person, link.team, link.slackUser, link.channel, link.linkedAt);
    this.mark(standing, now, person);
  }
  /** Whether a drain has anything to do now. */
  due(now: number): boolean {
    return this.sql.exec('SELECT 1 FROM slack_deliveries WHERE want>sent AND next_at<=? LIMIT 1', now).toArray().length > 0;
  }
  /** Send what is due, one call at a time. A drain already running is the one to wait on. */
  drain(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run() {
    const last = new Map<string, number>();
    for (let calls = 0; calls < DRAIN_CALLS; ) {
      const job = this.sql.exec<Delivery>('SELECT * FROM slack_deliveries WHERE want>sent AND next_at<=? ORDER BY next_at, card LIMIT 1', Date.now()).toArray()[0];
      if (!job) return;
      const link = this.sql.exec<Link>('SELECT * FROM slack_links WHERE person=?', job.person).toArray()[0];
      const card = this.deps.card(job.card);
      if (!card) { this.sql.exec('DELETE FROM slack_deliveries WHERE card=? AND person=?', job.card, job.person); continue; }
      if (!link || link.revoked_at) { this.settle(job, { next_at: NEVER, error: 'unlinked' }); continue; }
      // Not posted yet and already ended: there is nothing left to show or close.
      if (!job.ts && card.terminal) { this.settle(job, { sent: job.want, error: null }); continue; }
      const token = await this.deps.token(link.team);
      if (!token) { this.settle(job, { next_at: Date.now() + 300_000, error: 'not installed' }); continue; }
      const message = renderCard(card, this.deps.glassOrigin);
      const hash = await digest(JSON.stringify(message));
      if (job.ts && hash === job.sent_hash) { this.settle(job, { sent: job.want, error: null }); continue; }
      const wait = (last.get(link.channel) ?? 0) + CONVERSATION_SPACING_MS - Date.now();
      if (wait > 0) await (this.deps.pause ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
      const api = new SlackApi(token);
      const outcome = job.ts ? await api.update(link.channel, job.ts, message) : await api.post(link.channel, message);
      calls++; last.set(link.channel, Date.now());
      this.record(job, outcome, hash);
    }
  }
  private record(job: Delivery, outcome: SlackOutcome, hash: string) {
    const now = Date.now();
    if (outcome.kind === 'sent') this.settle(job, { sent: job.want, ts: outcome.ts, sent_hash: hash, attempts: 0, next_at: now, error: null });
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
