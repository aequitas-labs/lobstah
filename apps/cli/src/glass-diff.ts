import type {
  GlassDispatch,
  GlassHelm,
  GlassPr,
  GlassSnapshot,
  GlassStack,
  GlassTrap,
  LandedCatch,
  Notice,
  PrBadge,
  TendAttention,
  Watch,
} from '@lobstah/core';

/**
 * The glass page's pure helpers: the change detector, the tab route, the
 * filters, and the PR modal's data selection. The page's client bundle
 * (apps/cli/glass/src) imports them, and so do the tests — the browser and
 * the tests run the same code. Keep this module free of Node imports: it is
 * bundled into the page. Types come from @lobstah/core (type-only).
 *
 * Each section of the page gets a hash of the inputs it renders from — the
 * snapshot slice, the viewer's filters, and any time-derived flag (stale
 * heartbeats) that changes the markup. Ages ("3m") are not inputs: the page
 * updates those in place as text, so a quiet fleet rewrites nothing.
 */

// On deck's Landed section: the newest LANDED_MAX catches (done or failed)
// within the last LANDED_WINDOW_MS, whatever the report cursor says.
export const LANDED_MAX = 8;
export const LANDED_WINDOW_MS = 86400000;
export const STALE_DAEMON_MS = 90000;
export const STALE_SEAT_MS = 1800000;

/** This browser's preferences and filters (localStorage `spyglass`). */
export interface GlassPrefs {
  view: 'table' | 'cards';
  lane: string;
  repo: string;
  verb: string;
  q: string;
  lobs: boolean;
  chain: boolean;
  noticeKind: string;
}

export type ModalType = 'dispatch' | 'trap' | 'helm' | 'pr' | 'settings';
export interface ModalRef {
  type: ModalType;
  key: string;
}

export interface GlassUi {
  st: Partial<GlassPrefs>;
  open?: Set<string>;
  modal: ModalRef | null;
}

/** An item and whether its heartbeat has gone stale. */
export interface Seat<T> {
  x: T;
  stale: boolean;
}

/** The settings modal's "item": the read-only attention config line. */
export interface SettingsItem {
  attentionKinds: string[];
  attentionError?: string;
}
export type ModalItem = GlassHelm | GlassDispatch | GlassPr | GlassTrap | SettingsItem;

/**
 * A PR state badge's class: GitHub's state colors (.pr-merged purple,
 * .pr-open green, .pr-draft grey, .pr-closed red). An open PR whose badge
 * carries news (failed checks, changes requested, pending) keeps that tone;
 * a merge-state badge fills: conflicts in GitHub's red, behind grey.
 */
export function prBadgeClass(b: Partial<PrBadge> | undefined | null): string {
  if (!b) return 'dim';
  const state = b.state || 'open';
  if (state === 'open' && b.merge) return 'pr-' + b.merge;
  return state === 'open' && b.tone && b.tone !== 'ok' ? b.tone : 'pr-' + state;
}

export const GLASS_TABS = ['deck', 'dispatches', 'traps', 'prs', 'notices'] as const;
export type GlassTab = (typeof GLASS_TABS)[number];

export function tabFromHash(hash: string | undefined | null): GlassTab {
  const tab = String(hash || '').replace(/^#/, '');
  return (GLASS_TABS as readonly string[]).includes(tab) ? (tab as GlassTab) : 'deck';
}

export function visibleSections(tab: string): string[] {
  return ['chips', 'foot', 'modal', tabFromHash('#' + tab)];
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
      .join(',') +
    '}'
  );
}

export function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}

export function isStale(iso: string | undefined, ms: number, now: number): boolean {
  return !!iso && now - Date.parse(iso) > ms;
}

type Filterable = Pick<GlassDispatch, 'id' | 'lane' | 'repo' | 'verb' | 'note' | 'brief' | 'for'>;
export function matches(x: Filterable, st: Partial<GlassPrefs>): boolean {
  if (st.lane && x.lane !== st.lane) return false;
  if (st.repo && x.repo !== st.repo) return false;
  if (st.verb && x.verb !== st.verb) return false;
  if (st.q) {
    const q = st.q.toLowerCase();
    if (!(x.id + ' ' + (x.note || '') + ' ' + (x.brief || '') + ' ' + (x.repo || '') + ' ' + (x.for || '')).toLowerCase().includes(q))
      return false;
  }
  return true;
}

export function modalItem(d: GlassSnapshot, modal: ModalRef | null): ModalItem | null {
  if (!modal) return null;
  if (modal.type === 'helm') return d.helms.find((v) => v.grounds === modal.key) || null;
  if (modal.type === 'dispatch') return d.dispatches.find((v) => v.lane + ':' + v.id === modal.key) || null;
  if (modal.type === 'pr') return (d.prs || []).find((v) => v.key === modal.key) || null;
  if (modal.type === 'settings') return { attentionKinds: d.attentionKinds || [], attentionError: d.attentionError };
  return d.traps.find((v) => v.trapId === modal.key) || null;
}

/** An attention item as the deck hashes it: without its ticking age. */
export type DeckAttention = Omit<TendAttention, 'ageSecs'>;

export interface DeckInputs {
  view: GlassPrefs['view'] | undefined;
  attention: DeckAttention[];
  prAttention: DeckAttention[];
  landed: LandedCatch[];
  inflight: GlassDispatch[];
  traps: Seat<GlassTrap>[];
  stacks: GlassStack[];
  prs: GlassPr[];
  error: string | undefined;
}

export interface PrsInputs {
  view: GlassPrefs['view'] | undefined;
  stacks: GlassStack[];
  prs: GlassPr[];
  watches: Watch[];
}

export interface SectionInputs {
  chips: { daemon: GlassSnapshot['daemon']; daemonStale: boolean; helms: Seat<GlassHelm>[] };
  deck: DeckInputs;
  dispatches: { view: GlassPrefs['view'] | undefined; chain: boolean | undefined; list: GlassDispatch[] };
  traps: { view: GlassPrefs['view'] | undefined; list: Seat<GlassTrap>[] };
  prs: PrsInputs;
  notices: { list: Notice[] };
  foot: { version: string; repoUrl: string };
  modal: { modal: ModalRef | null; item: Seat<ModalItem> | null; prefs: { view: GlassPrefs['view'] | undefined; lobs: boolean | undefined } | undefined };
}

export function sectionInputs(d: GlassSnapshot, ui: GlassUi, now: number): SectionInputs {
  const st = ui.st;
  const query = String(st.q || '').toLowerCase();
  const hasQuery = (...parts: unknown[]) => !query || parts.join(' ').toLowerCase().includes(query);
  const seat = <T>(x: T): Seat<T> => ({ x, stale: isStale((x as { heartbeatAt?: string }).heartbeatAt, STALE_SEAT_MS, now) });
  const item = modalItem(d, ui.modal);
  const recent = (iso: string | undefined, ms: number) => !!iso && now - Date.parse(iso) <= ms;
  const deckTraps = (d.traps || []).filter(
    (t) =>
      (t.live || (t.notices || []).some((n) => (n.kind === 'trap-stowed' || n.kind === 'trap-ghosted') && recent(n.at, 3600000))) &&
      hasQuery(t.trapId, t.repo, t.worktree),
  );
  const noAge = ({ ageSecs, ...a }: TendAttention): DeckAttention => a;
  return {
    chips: { daemon: d.daemon, daemonStale: !!d.daemon && isStale(d.daemon.heartbeat, STALE_DAEMON_MS, now), helms: d.helms.map(seat) },
    deck: {
      view: st.view,
      attention: (d.attention || [])
        .filter((a) => (a.kind === 'question' || a.kind === 'landed') && recent(a.at, 86400000) && hasQuery(a.kind, a.repo, a.note, a.id))
        .map(noAge),
      prAttention: (d.attention || []).filter((a) => a.kind && a.kind.startsWith('pr:')).map(noAge),
      landed: (d.landed || [])
        .filter((a) => recent(a.at, LANDED_WINDOW_MS) && hasQuery(a.repo, a.note, a.id))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, LANDED_MAX),
      inflight: d.dispatches.filter((x) => x.bucket !== 'done' && matches(x, { ...st, lane: '', repo: '', verb: '' })),
      traps: deckTraps.map(seat),
      stacks: (d.stacks || []).filter((s) => s.open && hasQuery(s.repo, s.numbers.join(' '))),
      prs: (d.prs || []).filter((p) => p.state === 'OPEN'),
      error: d.attentionError,
    },
    dispatches: { view: st.view, chain: st.chain, list: d.dispatches.filter((x) => matches(x, st)) },
    traps: {
      view: st.view,
      list: d.traps.filter((t) => (!st.repo || t.repo === st.repo) && hasQuery(t.trapId, t.repo, t.worktree, t.harness)).map(seat),
    },
    prs: {
      view: st.view,
      stacks: (d.stacks || []).filter((s) => !st.repo || s.repo === st.repo),
      prs: (d.prs || []).filter(
        (p) => (!st.repo || p.repo === st.repo) && hasQuery(p.number, p.title, p.url, p.state, p.baseRefName, p.headRefName),
      ),
      watches: (d.watches || []).filter((w) => !String(w.key).startsWith('pr:')),
    },
    notices: {
      list: (d.notices || []).filter(
        (n) => (!st.repo || !n.repo || n.repo === st.repo) && (!st.noticeKind || n.kind === st.noticeKind) && hasQuery(n.kind, n.text, n.repo),
      ),
    },
    foot: { version: d.version, repoUrl: d.repoUrl },
    // The settings modal re-renders when a preference it shows changes.
    modal: {
      modal: ui.modal,
      item: item && seat(item),
      prefs: ui.modal && ui.modal.type === 'settings' ? { view: st.view, lobs: st.lobs } : undefined,
    },
  };
}

export interface PrModalView {
  pr: GlassPr;
  stack: {
    numbers: number[];
    position: number;
    size: number;
    floor: string;
    nextNumber?: number;
    nextMergeable: boolean;
    blockedBy?: number;
  } | null;
  chain: Array<{ id: string; verb?: string; modalKey?: string; culled?: boolean }>;
  watch: { key: string; owner: string; lastCheckedAt: string | null; lastError: string | null; cursor: string } | null;
}

/**
 * The PR modal's data: the PR, where it sits in its stack, the dispatch
 * chain (linked to their modals when still on disk), and the watch, whose
 * cursor is shown only here, never in the PRs table.
 */
export function prModalView(d: Pick<GlassSnapshot, 'prs' | 'stacks' | 'dispatches'>, key: string): PrModalView | null {
  const p = (d.prs || []).find((x) => x.key === key);
  if (!p) return null;
  const s = (d.stacks || []).find((x) => x.id === p.stackId);
  const byId = new Map((d.dispatches || []).map((x) => [x.id, x]));
  const chain = (p.dispatchIds || []).map((id) => {
    const x = byId.get(id);
    return x ? { id, verb: x.verb, modalKey: x.lane + ':' + x.id } : { id, culled: true };
  });
  const w = p.watch;
  return {
    pr: p,
    stack: s
      ? {
          numbers: s.numbers,
          position: p.position + 1,
          size: s.numbers.length,
          floor: s.floor,
          nextNumber: s.nextNumber,
          nextMergeable: !!p.nextMergeable,
          blockedBy: p.blockedBy,
        }
      : null,
    chain,
    watch: w ? { key: w.key, owner: w.owner || '', lastCheckedAt: w.lastCheckedAt || null, lastError: w.lastError || null, cursor: w.cursor } : null,
  };
}

/** What the PRs table says about a watch: a short state, never the cursor. */
export function watchState(w: { lastCheckedAt?: string } | undefined | null): { text: string; at: string | null } {
  return w ? { text: 'watching', at: w.lastCheckedAt || null } : { text: 'no watch', at: null };
}

export type SectionHashes = Record<string, string>;

export function hashInputs(inputs: object): SectionHashes {
  const out: SectionHashes = {};
  for (const k of Object.keys(inputs)) out[k] = hashStr(stableStringify((inputs as Record<string, unknown>)[k]));
  return out;
}

export function sectionHashes(d: GlassSnapshot, ui: GlassUi, now: number): SectionHashes {
  return hashInputs(sectionInputs(d, ui, now));
}

export function dirtySections(prev: Partial<SectionHashes> | null | undefined, next: SectionHashes): string[] {
  return Object.keys(next).filter((k) => !prev || prev[k] !== next[k]);
}
