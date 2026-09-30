import type {
  Attachment,
  GlassDecision,
  GlassDispatch,
  GlassHelm,
  GlassPr,
  GlassReport,
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
 * The glass page's pure helpers: the per-section selectors (what each
 * section shows, given the snapshot, the viewer's filters, and the clock),
 * the tab route, and the PR modal's data selection. The page's client
 * bundle (apps/cli/glass/src) imports them, and so do the tests — the
 * browser and the tests run the same code. Keep this module free of Node
 * imports: it is bundled into the page. Types come from @lobstah/core
 * (type-only).
 */

// On deck's Landed section: the newest LANDED_MAX catches (done or failed)
// within the last LANDED_WINDOW_MS, whatever the report cursor says.
export const LANDED_MAX = 8;
export const LANDED_WINDOW_MS = 86400000;
// On deck's traps section: at most DECK_TRAPS_MAX traps, then "+N more".
export const DECK_TRAPS_MAX = 8;
// On deck's reports section: at most REPORTS_MAX, unacked first, then "+N more".
export const REPORTS_MAX = 8;
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

export type ModalType = 'dispatch' | 'trap' | 'helm' | 'pr' | 'report' | 'settings';
export interface ModalRef {
  type: ModalType;
  key: string;
}

export interface GlassUi {
  st: Partial<GlassPrefs>;
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
export type ModalItem = GlassHelm | GlassDispatch | GlassPr | GlassTrap | GlassReport | SettingsItem;

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

export const GLASS_TABS = ['deck', 'dispatches', 'traps', 'prs', 'reports', 'notices'] as const;
export type GlassTab = (typeof GLASS_TABS)[number];

export function tabFromHash(hash: string | undefined | null): GlassTab {
  const tab = String(hash || '').replace(/^#/, '');
  return (GLASS_TABS as readonly string[]).includes(tab) ? (tab as GlassTab) : 'deck';
}

/**
 * The modal a report opens: its dispatch's modal (the report renders above
 * the attachments there), or a helm report's own modal.
 */
export function reportModal(key: string): ModalRef {
  const m = /^report:(work|chore):(.+)$/.exec(key);
  return m ? { type: 'dispatch', key: `${m[1]}:${m[2]}` } : { type: 'report', key };
}

/** `#report/<key>` opens that report's modal; any other hash opens none. */
export function modalFromHash(hash: string | undefined | null): ModalRef | null {
  const m = /^#?report\/(.+)$/.exec(String(hash || ''));
  if (!m) return null;
  try {
    return reportModal(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

/** `#decision/<key>`: the deck, scrolled to that decision's card. */
export const decisionHash = (key: string): string => `#decision/${encodeURIComponent(key)}`;

/** The decision (or raw question) key a `#decision/<key>` hash names, else null. */
export function decisionFromHash(hash: string | undefined | null): string | null {
  const m = /^#?decision\/(.+)$/.exec(String(hash || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** Where a decision's images are served, and where its answer is posted (glass.ts). */
export const decisionFileUrl = (key: string, name: string): string => `/decision/${encodeURIComponent(key)}/files/${encodeURIComponent(name)}`;
export const decisionAnswerUrl = (key: string): string => `/api/decision/${encodeURIComponent(key)}/answer`;

/**
 * One card in the deck's decisions section: a decision the helm framed, or
 * a worker's raw question the helm has not framed.
 */
export type DecisionCard =
  | {
      kind: 'decision';
      key: string;
      title: string;
      detail: string;
      options: string[];
      attachments: Attachment[];
      dispatch?: string;
      lane?: string;
      repo?: string;
      at: string;
    }
  | { kind: 'question'; key: string; verb: string; note: string; dispatch: string; lane: string; repo?: string; at: string };

/**
 * The deck's cards, newest first: each `decision` attention item joined to
 * its record, and each raw `question`. tend already hides a question its
 * decision frames.
 */
export function decisionCards(attention: readonly TendAttention[], decisions: readonly GlassDecision[]): DecisionCard[] {
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  const cards: DecisionCard[] = [];
  for (const a of attention) {
    if (a.kind === 'decision') {
      const d = byKey.get(a.key);
      if (!d) continue;
      cards.push({
        kind: 'decision',
        key: d.key,
        title: d.title,
        detail: d.detail,
        options: d.options,
        attachments: d.attachments,
        ...(d.dispatch ? { dispatch: d.dispatch, lane: d.lane ?? 'work' } : {}),
        ...(d.repo ? { repo: d.repo } : {}),
        at: d.askedAt,
      });
    } else if (a.kind === 'question') {
      cards.push({
        kind: 'question',
        key: a.key,
        verb: a.verb,
        note: a.note || a.verb,
        dispatch: a.id,
        lane: a.lane,
        ...(a.repo ? { repo: a.repo } : {}),
        at: a.at ?? '',
      });
    }
  }
  return cards.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

/** What an answered card says it sent: the option, the text's first line, the files. */
export function answerSummary(a: { option?: string; text?: string; files?: number }): string {
  const line = (a.text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return [
    a.option,
    line && (line.length > 80 ? line.slice(0, 79) + '…' : line),
    a.files ? `${a.files} file${a.files === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The report a dispatch filed, if any. */
export function dispatchReport(d: Pick<GlassSnapshot, 'reports'>, x: Pick<GlassDispatch, 'lane' | 'id'>): GlassReport | undefined {
  return (d.reports || []).find((r) => r.key === `report:${x.lane}:${x.id}`);
}

/**
 * Who a report is from, as its meta line says it: a trap's name, a headless
 * dispatch's id (first 8), or nothing for the helm's own report.
 */
export function reportFrom(r: Pick<GlassReport, 'author' | 'trap' | 'dispatch'>): string {
  if (r.author === 'helm') return '';
  if (r.trap) return r.trap;
  if (r.author === 'headless') return r.dispatch ? r.dispatch.slice(0, 8) : '';
  return r.author;
}

/** Reports in list order: unacked first, then newest first. */
export const reportOrder = (a: GlassReport, b: GlassReport): number =>
  Number(!!a.acked) - Number(!!b.acked) || b.filedAt.localeCompare(a.filedAt);

/** Where a report's markdown and images are served (glass.ts serveReport). */
export const reportMarkdownUrl = (key: string): string => `/report/${encodeURIComponent(key)}/md`;
export const reportFileUrl = (key: string, name: string): string => `/report/${encodeURIComponent(key)}/files/${encodeURIComponent(name)}`;

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
  if (modal.type === 'report') return (d.reports || []).find((v) => v.key === modal.key) || null;
  if (modal.type === 'settings') return { attentionKinds: d.attentionKinds || [], attentionError: d.attentionError };
  return d.traps.find((v) => v.trapId === modal.key) || null;
}

/** An attention item as the deck hashes it: without its ticking age. */
export type DeckAttention = Omit<TendAttention, 'ageSecs'>;

export interface DeckInputs {
  view: GlassPrefs['view'] | undefined;
  /** Decision and raw question cards, newest first. */
  decisions: DecisionCard[];
  prAttention: DeckAttention[];
  landed: LandedCatch[];
  /** Unacked first, then newest first; the deck shows REPORTS_MAX. */
  reports: GlassReport[];
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
  reports: { view: GlassPrefs['view'] | undefined; list: GlassReport[] };
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
  // A signed-on trap keeps its seat through heartbeat, claim, and listening
  // changes. Signed-off traps follow in most-recently-signed-off order.
  const signedOffAt = (t: GlassTrap) =>
    Math.max(0, ...(t.notices || []).filter((n) => n.kind === 'trap-stowed' || n.kind === 'trap-ghosted').map((n) => Date.parse(n.at) || 0));
  const orderedTraps = [...(d.traps || [])].sort((a, b) =>
    Number(b.live) - Number(a.live) ||
    (a.live ? (Date.parse(a.signedOnAt || '') || 0) - (Date.parse(b.signedOnAt || '') || 0)
      : signedOffAt(b) - signedOffAt(a)) ||
    (a.name ?? a.trapId).localeCompare(b.name ?? b.trapId));
  const deckTraps = orderedTraps
    .filter(
      (t) =>
        (t.live || (t.notices || []).some((n) => (n.kind === 'trap-stowed' || n.kind === 'trap-ghosted') && recent(n.at, 3600000))) &&
        hasQuery(t.name, t.trapId, t.repo, t.worktree),
    );
  const noAge = ({ ageSecs, ...a }: TendAttention): DeckAttention => a;
  return {
    chips: { daemon: d.daemon, daemonStale: !!d.daemon && isStale(d.daemon.heartbeat, STALE_DAEMON_MS, now), helms: d.helms.map(seat) },
    deck: {
      view: st.view,
      decisions: decisionCards(d.attention || [], d.decisions || []).filter((c) =>
        c.kind === 'decision' ? hasQuery(c.kind, c.repo, c.title, c.dispatch, c.detail) : hasQuery(c.kind, c.repo, c.note, c.dispatch),
      ),
      prAttention: (d.attention || []).filter((a) => a.kind && a.kind.startsWith('pr:')).map(noAge),
      landed: (d.landed || [])
        .filter((a) => recent(a.at, LANDED_WINDOW_MS) && hasQuery(a.repo, a.note, a.id))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, LANDED_MAX),
      reports: (d.reports || []).filter((r) => hasQuery(r.title, r.author, r.dispatch, r.repo)).sort(reportOrder),
      inflight: d.dispatches.filter((x) => x.bucket !== 'done' && matches(x, { ...st, lane: '', repo: '', verb: '' })),
      traps: deckTraps.map(seat),
      stacks: (d.stacks || []).filter((s) => s.open && hasQuery(s.repo, s.numbers.join(' '))),
      prs: (d.prs || []).filter((p) => p.state === 'OPEN'),
      error: d.attentionError,
    },
    dispatches: { view: st.view, chain: st.chain, list: d.dispatches.filter((x) => matches(x, st)) },
    traps: {
      view: st.view,
      list: orderedTraps.filter((t) => (!st.repo || t.repo === st.repo) && hasQuery(t.name, t.trapId, t.repo, t.worktree, t.harness)).map(seat),
    },
    prs: {
      view: st.view,
      stacks: (d.stacks || []).filter((s) => !st.repo || s.repo === st.repo),
      prs: (d.prs || []).filter(
        (p) => (!st.repo || p.repo === st.repo) && hasQuery(p.number, p.title, p.url, p.state, p.baseRefName, p.headRefName),
      ),
      watches: (d.watches || []).filter((w) => !String(w.key).startsWith('pr:')),
    },
    reports: {
      view: st.view,
      list: (d.reports || [])
        .filter((r) => (!st.repo || r.repo === st.repo) && hasQuery(r.title, r.author, r.dispatch, r.repo))
        .sort(reportOrder),
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
    /** Each number's PR title, index for index; '' when a PR has none. */
    titles: string[];
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
          titles: s.numbers.map((n) => (d.prs || []).find((x) => x.stackId === s.id && x.number === n)?.title || ''),
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

/** What the PRs table says about a watch: a short state, never the cursor. A failing watch says so; the modal has the reason. */
export function watchState(w: { lastCheckedAt?: string; lastError?: string } | undefined | null): { text: string; at: string | null } {
  if (!w) return { text: 'no watch', at: null };
  return { text: w.lastError ? 'failing' : 'watching', at: w.lastCheckedAt || null };
}
