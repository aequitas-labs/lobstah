import { GLASS_CARD_FAMILIES } from '../../../packages/core/src/backend-model.js';
import type {
  DispatchView, GlassCard, GlassCardAction, GlassCardFamily, GlassCardInput, GlassCardItem, GlassCardLink, GlassCardSource, GlassCardTerminal,
  WharfAck, WharfDocument, WharfHumanRequest,
} from '../../../packages/core/src/backend-model.js';
import { identifier, object, requireThat, text } from './protocol.js';
import type { Actor, Command } from './account.js';

/**
 * One row per card. `seq` names the card in links (`c<seq>`); source, family
 * and key are its identity, so a source restating an item finds its card.
 */
export const cardSchema = `
  CREATE TABLE IF NOT EXISTS cards (seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source,family,key));
`;
export const cardTables = ['cards'];
/** A card that ended is kept this long, so a projection of it can still close where it was shown. */
export const ENDED_CARD_MS = 7 * 86400_000;
/** At most this many cards in one boat's published set. */
export const BOAT_CARDS_MAX = 100;
/** A worker or boat counts as online while it checked in within this window: the claim lease. */
const ONLINE_MS = 90_000;

type Worker = { id: string; boatName: string; repoRemote: string; lastCheckIn: string; current: string | null; harness?: string };
type Boat = { id: string; name: string; revoked: number; permissions: string[]; lastCheckIn: string | null; repos: string[] };
/** The wharf's own records a projection reads. The account supplies them, as its glass reads them. */
export interface CardRecords {
  dispatches(): DispatchView[];
  documents(): WharfDocument[];
  requests(now: number): WharfHumanRequest[];
  workers(): Worker[];
  boats(): Boat[];
}
/** A card as a projection derives it, before the store gives it an id and a revision. */
export type ProjectedCard = GlassCardInput & { item?: GlassCardItem };

const firstLine = (s: string, max = 150) => {
  const line = s.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const prLinks = (urls: string[] | undefined): GlassCardLink[] =>
  (urls ?? []).slice(0, 4).map((url) => ({ label: `PR #${url.split('/').at(-1)}`, url }));
const seenAction = (seen: WharfAck | undefined): GlassCardAction[] => (seen ? [] : [{ kind: 'seen' }]);

/** A published decision: its options as answers while it stands, its answer or withdrawal once it does not. */
export function decisionCard(d: WharfDocument): ProjectedCard {
  const terminal: GlassCardTerminal | undefined = d.answer
    ? { state: 'answered', at: d.answer.at, by: d.answer.by, outcome: d.answer.option ?? firstLine(d.answer.text ?? '', 300) }
    : d.withdrawn ? { state: 'withdrawn', at: d.at } : undefined;
  return {
    family: 'decision', key: d.id, stateHash: `${d.at}:${d.answer?.at ?? ''}:${d.withdrawn ? 'withdrawn' : ''}`, sourceAt: d.answer?.at ?? d.at,
    title: firstLine(d.title, 300), item: { kind: 'decision', id: d.id },
    actions: terminal ? [] : [...(d.options ?? []).map((option): GlassCardAction => ({ kind: 'answer', option })), { kind: 'answer-text' }, ...seenAction(d.ack)],
    ...(d.ack ? { seen: d.ack } : {}), ...(terminal ? { terminal } : {}),
  };
}
/** A report stands until a person has seen it; it never asks for an answer. */
export function reportCard(d: WharfDocument): ProjectedCard {
  return {
    family: 'report', key: d.id, stateHash: `${d.at}:${d.withdrawn ? 'withdrawn' : ''}`, sourceAt: d.at, title: firstLine(d.title, 300),
    item: { kind: 'report', id: d.id }, actions: d.withdrawn ? [] : seenAction(d.ack),
    ...(d.ack ? { seen: d.ack } : {}), ...(d.withdrawn ? { terminal: { state: 'withdrawn', at: d.at } } : {}),
  };
}
const REVIEW_ENDED: Record<string, GlassCardTerminal['state']> = { posted: 'resolved', dismissed: 'resolved', withdrawn: 'withdrawn' };
/** A review request: open it in its review tool; dismiss it while it asks for the person. */
export function reviewCard(d: WharfDocument): ProjectedCard {
  const r = d.review!;
  const ended = d.withdrawn ? 'withdrawn' : REVIEW_ENDED[r.state];
  return {
    family: 'review', key: d.id, stateHash: `${r.round}:${r.state}:${r.headSha ?? ''}:${r.stands ? 'stands' : ''}:${d.withdrawn ? 'withdrawn' : ''}`, sourceAt: d.at,
    title: firstLine(d.title, 300), ...(r.reason ? { summary: r.reason } : {}), item: { kind: 'review', id: d.id },
    links: [...(r.open ? [{ label: 'Open review', url: r.open }] : []), { label: 'Open PR', url: r.pr }],
    actions: !ended && r.stands ? [{ kind: 'review-dismiss' }] : [],
    quiet: !r.stands,
    ...(ended ? { terminal: { state: ended, at: d.at, outcome: r.state } } : {}),
  };
}
/** A job's progress: what it is doing and where it waits. It ends when the job lands or is cancelled. */
export function dispatchCard(v: DispatchView): ProjectedCard {
  const s = v.status;
  const terminal: GlassCardTerminal | undefined = v.state === 'cancelled' ? { state: 'cancelled', at: '' }
    : v.state === 'done' ? { state: 'landed', at: s?.at ?? '', outcome: s?.verb } : undefined;
  const waits = s?.waitingOn ? `waiting on ${s.waitingOn}${s.until ? ` until ${s.until}` : ''}` : undefined;
  const summary = [s?.note, waits, v.unservable?.note].filter(Boolean).join('\n');
  return {
    family: 'dispatch', key: v.id, stateHash: `${v.state}:${s?.at ?? ''}:${s?.verb ?? ''}:${v.unservable ? 'unservable' : ''}`, sourceAt: s?.at ?? '',
    title: firstLine(v.brief), ...(summary ? { summary } : {}), item: { kind: 'job', id: v.id },
    links: [...prLinks(s?.evidence?.prUrls), ...(s?.link ? [{ label: 'Open link', url: s.link }] : [])],
    actions: terminal ? [] : [{ kind: 'message-helm' }, { kind: 'cancel' }],
    quiet: !s || ['working', 'paused'].includes(s.verb),
    ...(terminal ? { terminal } : {}),
  };
}
/**
 * A worker's raw question, one card per question: the status it stands on is
 * part of the key, so a new question is a new card and the old one ends.
 * A standing decision that names the job asks it properly, and this does not.
 */
export function questionCard(v: DispatchView, framed: boolean): ProjectedCard | undefined {
  const s = v.status;
  if (v.state !== 'active' || !s || !['needs-decision', 'blocked'].includes(s.verb) || framed) return undefined;
  const seen = v.ack?.status === s.at ? { at: v.ack.at, by: v.ack.by } : undefined;
  return {
    family: 'question', key: `${v.id}@${s.at}`, stateHash: `${s.at}:${s.verb}`, sourceAt: s.at,
    title: firstLine(v.brief), ...(s.note ? { summary: s.note } : {}), item: { kind: 'job', id: v.id },
    links: s.link ? [{ label: 'Open link', url: s.link }] : [], actions: [{ kind: 'message-helm' }, ...seenAction(seen)],
    ...(seen ? { seen } : {}),
  };
}
/** A landing stands until a person has seen it. */
export function landedCard(v: DispatchView): ProjectedCard | undefined {
  const s = v.status;
  if (v.state === 'cancelled' || !s || !['done', 'failed'].includes(s.verb)) return undefined;
  const seen = v.ack?.status === s.at ? { at: v.ack.at, by: v.ack.by } : undefined;
  return {
    family: 'landed', key: v.id, stateHash: `${s.at}:${s.verb}`, sourceAt: s.at, title: firstLine(v.brief),
    summary: [s.verb, s.note].filter(Boolean).join(' · '), item: { kind: 'job', id: v.id },
    links: [...prLinks(s.evidence?.prUrls), ...(s.link ? [{ label: 'Open link', url: s.link }] : [])], actions: seenAction(seen),
    ...(seen ? { seen } : {}),
  };
}
/** A person's request of the fleet: its receipt and outcome. It ends fulfilled or expired. */
export function requestCard(r: WharfHumanRequest): ProjectedCard {
  const ended = r.state === 'fulfilled' || r.state === 'expired';
  const waiting = r.state === 'queued' && r.waitingForHelm;
  return {
    family: 'request', key: r.id, stateHash: `${r.state}:${r.outcome ?? ''}:${waiting ? 'waiting' : ''}`, sourceAt: r.at,
    title: r.kind === 'message' ? 'Message to the helm' : r.kind === 'trap-request' ? 'Trap request' : 'Review dismissal',
    summary: [r.text ? firstLine(r.text, 300) : r.repo, waiting ? 'waiting for helm' : r.state, r.outcome].filter(Boolean).join(' · '),
    ...(r.dispatch ? { item: { kind: 'job', id: r.dispatch } } : {}), quiet: true,
    ...(ended ? { terminal: { state: r.state as 'fulfilled' | 'expired', at: r.state === 'expired' ? r.expiresAt : '', ...(r.outcome ? { outcome: r.outcome } : {}) } } : {}),
  };
}
const online = (lastCheckIn: string | null, now: number) => !!lastCheckIn && now - Date.parse(lastCheckIn) < ONLINE_MS;
/** A signed-on worker: online or not, and its current job. Check-ins do not change it; going offline does. */
export function trapCard(w: Worker, now: number): ProjectedCard {
  const live = online(w.lastCheckIn, now);
  return {
    family: 'trap', key: w.id, stateHash: `${live ? 'online' : 'offline'}:${w.current ?? ''}:${w.harness ?? ''}`, sourceAt: w.lastCheckIn,
    title: w.id, summary: [w.boatName, w.repoRemote, live ? (w.current ? `job ${w.current}` : 'no current job') : 'offline'].join(' · '),
    item: { kind: 'trap', id: w.id }, quiet: true,
  };
}
/** A boat's access: online, offline or revoked, and what it may do. */
export function boatCard(b: Boat, now: number): ProjectedCard {
  const state = b.revoked ? 'revoked' : online(b.lastCheckIn, now) ? 'online' : 'offline';
  return {
    family: 'boat', key: b.id, stateHash: `${state}:${b.permissions.join(',')}`, sourceAt: b.lastCheckIn ?? '',
    title: b.name, summary: [state, b.permissions.join(', '), ...b.repos.slice(0, 4)].join(' · '), quiet: true,
  };
}
/** Every card the wharf's own records hold. Boats publish the rest. */
export function wharfCards(records: CardRecords, now: number): ProjectedCard[] {
  const documents = records.documents();
  const framed = new Set(documents.filter((d) => d.kind === 'decision' && !d.answer && !d.withdrawn && d.dispatch).map((d) => d.dispatch!));
  return [
    ...documents.map((d) => (d.kind === 'decision' ? decisionCard(d) : d.kind === 'report' ? reportCard(d) : reviewCard(d))),
    ...records.dispatches().flatMap((v) => [dispatchCard(v), questionCard(v, framed.has(v.id)), landedCard(v)].filter((c): c is ProjectedCard => !!c)),
    ...records.requests(now).map(requestCard),
    ...records.workers().map((w) => trapCard(w, now)),
    ...records.boats().map((b) => boatCard(b, now)),
  ];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isoTime = (value: unknown): string => {
  const s = text(value, 40); requireThat(ISO.test(s) && Number.isFinite(Date.parse(s)), 400, 'card times are ISO UTC timestamps'); return s;
};
/** A card's links are HTTPS: a phone opens them straight from a message. */
function cardLink(value: unknown): GlassCardLink {
  const l = object(value), url = text(l.url, 2048);
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { parsed = undefined; }
  requireThat(parsed?.protocol === 'https:' && !parsed.username && !parsed.password, 400, 'card links must be https URLs');
  return { label: text(l.label, 75), url };
}
const ACTION_KINDS = ['answer', 'answer-text', 'allow-once', 'allow-always', 'deny', 'seen', 'message-helm', 'cancel', 'review-dismiss'];
function cardAction(value: unknown): GlassCardAction {
  const a = object(value);
  requireThat(ACTION_KINDS.includes(String(a.kind)), 400, 'unknown card action');
  if (a.kind === 'answer') return { kind: 'answer', option: text(a.option, 2000) };
  return { kind: a.kind } as GlassCardAction;
}
const TERMINAL_STATES = ['answered', 'withdrawn', 'resolved', 'landed', 'cancelled', 'expired', 'fulfilled'];
/** A boat's statement of one card, checked field by field: nothing it sends becomes an instruction. */
export function boatCardInput(value: unknown): GlassCardInput {
  const c = object(value);
  requireThat(Object.keys(c).every((k) => ['family', 'key', 'stateHash', 'sourceAt', 'title', 'summary', 'grounds', 'links', 'actions', 'quiet', 'seen', 'terminal'].includes(k)), 400, 'unexpected card field');
  requireThat(GLASS_CARD_FAMILIES.includes(c.family as GlassCardFamily), 400, 'unknown card family');
  const links = c.links ?? [], actions = c.actions ?? [];
  requireThat(Array.isArray(links) && links.length <= 8 && Array.isArray(actions) && actions.length <= 12, 400, 'at most 8 links and 12 actions per card');
  const card: GlassCardInput = {
    family: c.family as GlassCardFamily, key: text(c.key, 300), stateHash: text(c.stateHash, 200), sourceAt: isoTime(c.sourceAt),
    title: text(c.title, 300), links: links.map(cardLink), actions: actions.map(cardAction),
  };
  if (c.summary !== undefined) card.summary = text(c.summary, 2400);
  if (c.grounds !== undefined) card.grounds = identifier(c.grounds);
  if (c.quiet !== undefined) { requireThat(typeof c.quiet === 'boolean', 400, 'quiet is true or false'); card.quiet = c.quiet; }
  if (c.seen !== undefined) { const s = object(c.seen); card.seen = { at: isoTime(s.at), by: text(s.by, 100) }; }
  if (c.terminal !== undefined) {
    const t = object(c.terminal);
    requireThat(TERMINAL_STATES.includes(String(t.state)), 400, 'unknown card end state');
    card.terminal = { state: t.state as GlassCardTerminal['state'], at: isoTime(t.at), ...(t.by !== undefined ? { by: text(t.by, 100) } : {}), ...(t.outcome !== undefined ? { outcome: text(t.outcome, 300) } : {}) };
  }
  return card;
}

type CardRow = { seq: number; data: string };
/**
 * The account's canonical cards. Each source restates what it holds; the
 * store keeps one card per item, advances its revision when its state does,
 * and ends a card its source no longer states.
 */
export class CardStore {
  constructor(private sql: SqlStorage) {}
  private row(source: GlassCardSource, family: string, key: string): CardRow | undefined {
    return this.sql.exec<CardRow>('SELECT seq,data FROM cards WHERE source=? AND family=? AND key=?', source, family, key).toArray()[0];
  }
  /** Store one card's current state. Returns the card when anything about it changed. */
  upsert(source: GlassCardSource, input: ProjectedCard, now: number): GlassCard | undefined {
    const row = this.row(source, input.family, input.key);
    const before = row ? (JSON.parse(row.data) as GlassCard) : undefined;
    // An end keeps the time it was first seen: restating it is not a new end.
    // A source that does not know when an item ended leaves the time empty; the wharf saw it now.
    const terminal = !input.terminal ? undefined
      : before?.terminal?.state === input.terminal.state ? { ...input.terminal, at: before.terminal.at }
      : { ...input.terminal, at: input.terminal.at || new Date(now).toISOString() };
    const restated = before && before.stateHash === input.stateHash;
    const card: GlassCard = {
      ...input, links: input.links ?? [], actions: input.actions ?? [], ...(terminal ? { terminal } : {}),
      id: before?.id ?? '', source, revision: restated ? before.revision : (before?.revision ?? 0) + 1,
      observedAt: restated ? before.observedAt : new Date(now).toISOString(),
    };
    if (before && JSON.stringify(before) === JSON.stringify({ ...card, id: before.id })) return undefined;
    if (row) {
      card.id = before!.id;
      this.sql.exec('UPDATE cards SET data=? WHERE seq=?', JSON.stringify(card), row.seq);
    } else {
      const seq = this.sql.exec<{ seq: number }>('INSERT INTO cards(source,family,key,data) VALUES (?,?,?,?) RETURNING seq', source, input.family, input.key, '{}').one().seq;
      card.id = `c${seq}`;
      this.sql.exec('UPDATE cards SET data=? WHERE seq=?', JSON.stringify(card), seq);
    }
    return card;
  }
  /**
   * Restate a source's whole set: each card is stored, and a standing card
   * the source no longer states ends as resolved. That is a new revision, so
   * wherever it was shown can close. Long-ended cards are removed.
   */
  replace(source: GlassCardSource, cards: ProjectedCard[], now: number): GlassCard[] {
    const changed: GlassCard[] = [];
    const stated = new Set(cards.map((c) => `${c.family}\n${c.key}`));
    for (const card of cards) { const c = this.upsert(source, card, now); if (c) changed.push(c); }
    for (const row of this.sql.exec<CardRow & { family: string; key: string }>('SELECT seq,family,key,data FROM cards WHERE source=?', source).toArray()) {
      if (stated.has(`${row.family}\n${row.key}`)) continue;
      const card = JSON.parse(row.data) as GlassCard;
      if (card.terminal) {
        if (now - Date.parse(card.terminal.at) > ENDED_CARD_MS || !Number.isFinite(Date.parse(card.terminal.at))) this.sql.exec('DELETE FROM cards WHERE seq=?', row.seq);
        continue;
      }
      const ended: GlassCard = { ...card, stateHash: `${card.stateHash}:resolved`, revision: card.revision + 1, observedAt: new Date(now).toISOString(),
        actions: [], terminal: { state: 'resolved', at: new Date(now).toISOString() } };
      this.sql.exec('UPDATE cards SET data=? WHERE seq=?', JSON.stringify(ended), row.seq);
      changed.push(ended);
    }
    return changed;
  }
  get(id: string): GlassCard | undefined {
    const seq = /^c(\d{1,15})$/.exec(id)?.[1];
    const row = seq ? this.sql.exec<CardRow>('SELECT seq,data FROM cards WHERE seq=?', Number(seq)).toArray()[0] : undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  /** Standing cards and those that ended within a day, newest state first. */
  list(now: number): GlassCard[] {
    const since = new Date(now - 86400_000).toISOString();
    return this.sql.exec<CardRow>(`SELECT seq,data FROM cards WHERE json_extract(data,'$.terminal') IS NULL OR json_extract(data,'$.terminal.at')>=?
      ORDER BY json_extract(data,'$.observedAt') DESC LIMIT 200`, since).toArray().map((r) => JSON.parse(r.data));
  }
}

/** `changed` hears every card that moved, inside the same transaction: where cards are shown follows. */
type Hooks = { read: (actor: Actor) => void; publish: (actor: Actor) => void; changed: (cards: GlassCard[], now: number) => void };
/** The account's card routes: read the cards, and a boat's restatement of its own. */
export class Cards {
  readonly store: CardStore;
  constructor(sql: SqlStorage, private records: CardRecords, private hooks: Hooks) { this.store = new CardStore(sql); }
  /** Bring the wharf's own cards up to date with its records. Runs inside every command's transaction. */
  project(now: number): GlassCard[] {
    const changed = this.store.replace('wharf', wharfCards(this.records, now), now);
    if (changed.length) this.hooks.changed(changed, now);
    return changed;
  }
  execute(c: Command, actor: Actor, now: number): { status: number; value: unknown } | undefined {
    const parts = c.path.split('/');
    if (parts[0] !== 'cards') return undefined;
    // A read sees this command's records, not the last command's.
    if (parts.length === 1 && c.method === 'GET') { this.hooks.read(actor); this.project(now); return { status: 200, value: this.store.list(now) }; }
    if (parts.length === 2 && c.method === 'GET') {
      this.hooks.read(actor); this.project(now);
      const card = this.store.get(text(parts[1], 20)); requireThat(card, 404, 'card not found'); return { status: 200, value: card };
    }
    if (parts.length === 1 && c.method === 'POST') {
      // A boat restates the cards of its own glass. It cannot write another source's cards.
      this.hooks.publish(actor); requireThat(actor.kind === 'boat', 403, 'boat credential required');
      const b = object(c.body);
      requireThat(Array.isArray(b.cards) && b.cards.length <= BOAT_CARDS_MAX, 400, `at most ${BOAT_CARDS_MAX} cards`);
      const cards = b.cards.map(boatCardInput);
      requireThat(new Set(cards.map((x) => `${x.family}\n${x.key}`)).size === cards.length, 400, 'duplicate card');
      const changed = this.store.replace(`boat:${actor.id}`, cards, now);
      if (changed.length) this.hooks.changed(changed, now);
      return { status: 200, value: { changed: changed.length } };
    }
    return undefined;
  }
}
