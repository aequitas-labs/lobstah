import { createHash, randomUUID } from 'node:crypto';
import { backendScopes, listNotices, loadConfig, standingDecisions, wharfFor } from '@lobstah/core';
import type { BackendScope, Config, DecisionMeta, GlassCardAction, GlassCardFamily, GlassCardInput, GlassCardLink, Notice, TendAttention } from '@lobstah/core';
import { buildTendReport } from './tend.js';
import { isHostedKey } from './hosted-view.js';

/** The wharf takes at most this many cards from one boat. */
export const BOAT_CARDS_MAX = 100;
/** How often the daemon looks for changed cards, and how often it restates an unchanged set. */
export const CARDS_CHECK_MS = 15_000;
export const CARDS_RESTATE_MS = 600_000;

/** One wharf this boat restates its cards to: its grounds, and the cards of their repos. */
export interface BoatCardSet {
  wharf: string;
  scope: BackendScope;
  cards: GlassCardInput[];
}

const FAMILY: Record<string, GlassCardFamily> = {
  question: 'question', decision: 'decision', landed: 'landed', report: 'report', review: 'review',
  'stack-ready': 'stack', watch: 'notice', 'dispatch-progress': 'dispatch',
};
const iso = (value: string | undefined, now: number) => {
  const ms = value ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(ms) ? ms : now).toISOString();
};
const firstLine = (s: string, max: number) => {
  const line = s.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const https = (label: string, url: string | undefined): GlassCardLink[] => (url && /^https:\/\//.test(url) ? [{ label, url }] : []);

/** What a permission card says: the exact command or path, who asked, and what "Allow always" covers. */
function permissionSummary(d: DecisionMeta): string {
  const p = d.permission!;
  const asked = p.command ? `Run: ${p.command}` : p.path ? `Write: ${p.path}` : p.sessionGrant ? `Use ${p.sessionGrant.tools} for this session: ${p.sessionGrant.reason}` : '';
  const who = [p.trap && `trap ${p.trap}`, p.harness !== 'any' && p.harness, d.repo].filter(Boolean).join(' · ');
  const always = d.optionNotes?.['Allow always'];
  return [asked, who, always && `Allow always: ${always}`].filter(Boolean).join('\n');
}

/** One local attention item as a card, or nothing when it is the wharf's own. */
export function attentionCard(a: TendAttention, decision: DecisionMeta | undefined, grounds: string, now: number): GlassCardInput | undefined {
  // A wharf item is already the wharf's card; a boat never restates it.
  if (isHostedKey(a.key) || a.wharf) return undefined;
  const permission = !!decision?.permission;
  const family: GlassCardFamily | undefined = a.kind.startsWith('pr:') ? 'pr' : permission ? 'permission' : FAMILY[a.kind];
  if (!family) return undefined;
  const actions: GlassCardAction[] = permission ? [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }]
    : family === 'decision' ? [...(decision?.options ?? []).map((option): GlassCardAction => ({ kind: 'answer', option })), { kind: 'answer-text' }]
    : family === 'question' ? [{ kind: 'answer-text' }]
    : a.acked || family === 'dispatch' ? [] : [{ kind: 'seen' }];
  const summary = permission ? permissionSummary(decision!) : a.note && a.note.includes('\n') ? a.note : undefined;
  return {
    family, key: a.key, stateHash: a.stateHash, sourceAt: iso(a.at ?? a.standingSince, now),
    title: firstLine(decision?.title ?? a.note ?? a.verb, 300) || a.kind, grounds,
    ...(summary ? { summary: summary.slice(0, 2400) } : {}),
    links: [...https('Open PR', a.prUrl), ...https('Open review', a.reviewUrl)],
    actions, ...(a.quiet ? { quiet: true } : {}), ...(a.acked ? { seen: a.acked } : {}),
  };
}
/** A notice of a wharf grounds' repo, as a card that stands while the notice is in the recent list. */
export function noticeCard(n: Notice, grounds: string, now: number): GlassCardInput {
  return {
    family: 'notice', key: `notice:${n.seq}`, stateHash: n.stateHash ?? n.seq, sourceAt: iso(n.at, now), title: firstLine(n.text, 300) || n.kind,
    grounds, ...(n.text.includes('\n') ? { summary: n.text.slice(0, 2400) } : {}), links: https('Open', n.url), actions: [], quiet: !!n.quiet,
  };
}

/**
 * The cards this boat may restate, by wharf. Only repos of a grounds bound
 * to a wharf leave the machine; an item of a local-only grounds, or of no
 * known repo, stays here. Standing items come first when a set is over the
 * wharf's limit.
 */
export function boatCards(cfg: Pick<Config, 'grounds' | 'wharves' | 'repos'>, attention: TendAttention[], decisions: DecisionMeta[], notices: Notice[], now: number): BoatCardSet[] {
  const scopes = backendScopes(cfg).filter((s): s is Extract<BackendScope, { kind: 'wharf' }> => s.kind === 'wharf');
  const scopeOf = (repo: string | undefined, grounds?: string) =>
    (repo ? scopes.find((s) => s.repos.includes(repo)) : undefined) ?? (grounds ? scopes.find((s) => s.grounds === grounds) : undefined);
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  const sets = new Map<string, BoatCardSet>();
  const add = (scope: BackendScope, card: GlassCardInput) => {
    const set = sets.get(scope.wharf!) ?? { wharf: scope.wharf!, scope, cards: [] };
    if (!set.cards.some((c) => c.family === card.family && c.key === card.key)) set.cards.push(card);
    sets.set(scope.wharf!, set);
  };
  for (const a of attention) {
    const decision = a.kind === 'decision' ? byKey.get(a.key) : undefined;
    const scope = scopeOf(a.repo ?? decision?.repo, decision?.grounds);
    const card = scope && attentionCard(a, decision, scope.grounds, now);
    if (card) add(scope, card);
  }
  for (const n of notices) {
    const scope = scopeOf(n.repo);
    if (scope) add(scope, noticeCard(n, scope.grounds, now));
  }
  for (const set of sets.values()) {
    set.cards.sort((x, y) => Number(!!x.quiet) - Number(!!y.quiet) || y.sourceAt.localeCompare(x.sourceAt));
    set.cards.length = Math.min(set.cards.length, BOAT_CARDS_MAX);
  }
  return [...sets.values()];
}

/** What this daemon last restated to each wharf, so an unchanged set is not sent again soon. */
const restated = new Map<string, { hash: string; at: number; retryAt: number }>();
/** A failed restatement waits this long: an older wharf with no card route, or a wharf that is away. */
export const CARDS_RETRY_MS = 60_000;
let checkedAt = 0;
/**
 * The daemon's remote poll: restate this boat's cards to each wharf whose
 * set changed, and to every wharf now and then. A wharf that has every
 * grounds it holds stated as empty still hears it, so its cards end.
 */
export async function publishBoatCards(now = Date.now(), log: (m: string) => void = () => {}): Promise<void> {
  if (now - checkedAt < CARDS_CHECK_MS) return;
  checkedAt = now;
  const cfg = loadConfig();
  const scopes = backendScopes(cfg).filter((s) => s.kind === 'wharf');
  if (!scopes.length) return;
  const sets = boatCards(cfg, buildTendReport(now).attention, standingDecisions(), listNotices(20), now);
  // Every wharf is stated, even with nothing: an empty set ends what it showed.
  const all = new Map<string, BoatCardSet>(scopes.map((s) => [s.wharf!, { wharf: s.wharf!, scope: s, cards: [] }]));
  for (const set of sets) all.set(set.wharf, set);
  for (const set of all.values()) {
    const hash = createHash('sha256').update(JSON.stringify(set.cards)).digest('hex');
    const last = restated.get(set.wharf);
    if (last && (now < last.retryAt || (last.hash === hash && now - last.at < CARDS_RESTATE_MS))) continue;
    try {
      await wharfFor(set.scope).request('cards', { cards: set.cards }, `cards-${randomUUID()}`);
      restated.set(set.wharf, { hash, at: now, retryAt: 0 });
    } catch (e) {
      restated.set(set.wharf, { hash: last?.hash ?? '', at: last?.at ?? 0, retryAt: now + CARDS_RETRY_MS });
      log(`wharf ${set.wharf} cards: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
