import type {
  Attachment,
  GlassBeats,
  GlassDecision,
  GlassDispatch,
  GlassDispatchSummary,
  GlassHelm,
  GlassOlderKind,
  GlassOlderPage,
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
/** A trap's catch count as its badge shows it: capped at 999+. */
export const catchCount = (count: number): string => (count > 999 ? '999+' : String(count));

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
  modal: ModalRef | null;
  detail?: DispatchDetail | null;
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
/** A dispatch modal shows the summary until the detail lands, then both. */
export type ModalItem = GlassHelm | GlassDispatchSummary | GlassDispatch | GlassPr | GlassTrapView | SettingsItem;

/** A trap as the page renders it: its catch ids resolved against the snapshot's dispatches. */
export type GlassTrapView = Omit<GlassTrap, 'catches'> & { catches: GlassDispatchSummary[] };

export interface ResumeSession {
  harness?: string;
  sessionId?: string;
  link?: string;
  window?: { bundleId?: string; entrypoint?: string };
  desktopThread?: boolean;
}

/** The terminal panel inside Claude Desktop is still a CLI session. */
export function desktopSession(session: ResumeSession): boolean {
  if (session.harness === 'codex')
    return !!session.desktopThread || session.link?.startsWith('codex://threads/') === true || session.window?.bundleId === 'com.openai.codex';
  if (session.harness === 'claude')
    return session.window?.entrypoint === 'claude-desktop' || (!session.window?.entrypoint && session.link?.startsWith('claude://claude.ai/') === true);
  return false;
}

/** Resume only a known terminal harness; app sessions use their open link. */
export function resumeCommand(session: ResumeSession): string | undefined {
  const { harness, sessionId } = session;
  if (desktopSession(session)) return undefined;
  if (!sessionId) return undefined;
  if (harness === 'codex') return 'codex resume ' + sessionId;
  if (harness === 'claude') return 'claude --resume ' + sessionId;
  return undefined;
}

/**
 * A catch id with no dispatch in the snapshot: an old catch /data left out.
 * It renders as its id with an unknown state; its modal fetches the rest.
 */
export function missingCatch(id: string): GlassDispatchSummary {
  return { id, lane: 'work', bucket: 'done', repo: '', title: '', verb: 'unknown', sort: 0 };
}

const dispatchIndex = new WeakMap<GlassDispatchSummary[], Map<string, GlassDispatchSummary>>();

/** The trap with its catches resolved, in the order the server sent the ids. */
export function trapView(d: Pick<GlassSnapshot, 'dispatches'>, t: GlassTrap): GlassTrapView {
  const list = d.dispatches || [];
  let byId = dispatchIndex.get(list);
  if (!byId) dispatchIndex.set(list, (byId = new Map(list.map((x) => [x.id, x]))));
  return { ...t, catches: (t.catches || []).map((id) => byId!.get(id) ?? missingCatch(id)) };
}

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

export const GLASS_TABS = ['deck', 'dispatches', 'traps', 'prs', 'reports', 'notices', 'stats'] as const;
export type GlassTab = (typeof GLASS_TABS)[number];

export function tabFromHash(hash: string | undefined | null): GlassTab {
  const tab = String(hash || '').replace(/^#/, '');
  return (GLASS_TABS as readonly string[]).includes(tab) ? (tab as GlassTab) : 'deck';
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

/** Where a dispatch's and a trap's attachment images are served (glass.ts serveAttachment). */
export const dispatchFileUrl = (lane: string, id: string, name: string): string =>
  `/attachment/dispatch/${encodeURIComponent(lane)}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
export const trapFileUrl = (trapId: string, name: string): string => `/attachment/trap/${encodeURIComponent(trapId)}/${encodeURIComponent(name)}`;

/** An attachment name the glass shows as an image. */
export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** Where a decision's images are served (glass.ts). */
export const decisionFileUrl = (key: string, name: string): string => `/decision/${encodeURIComponent(key)}/files/${encodeURIComponent(name)}`;

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
      /** When the human first viewed it in the decision modal; absent = unread. */
      viewedAt?: string;
    }
  | { kind: 'question'; key: string; verb: string; note: string; dispatch: string; lane: string; repo?: string; at: string; viewedAt?: string };

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
        ...((d.viewedAt ?? a.viewedAt) ? { viewedAt: d.viewedAt ?? a.viewedAt } : {}),
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
        ...(a.viewedAt ? { viewedAt: a.viewedAt } : {}),
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

/** A report's own page on the glass: it opens in a new tab and renders once. */
export const reportPageUrl = (key: string): string => `/report/${encodeURIComponent(key)}`;

/** The report key an old `#report/<key>` link names, else null: it redirects to the report's page. */
export function reportFromHash(hash: string | undefined | null): string | null {
  const m = /^#?report\/(.+)$/.exec(String(hash || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * A hash a glass page may be asked to show (glass-presence.ts): a tab
 * (`#prs`), a decision card (`#decision/<key>`), or a report
 * (`#report/<key>`), read by the parsers the page reads `location.hash`
 * with. Empty means "the glass as it is". The server checks it before it
 * queues a show, and the page again before it applies one.
 */
export function validShowHash(hash: unknown): hash is string {
  if (typeof hash !== 'string') return false;
  if (hash === '') return true;
  if (hash.length > 1024 || !hash.startsWith('#') || /[\s\x00-\x1f\x7f]/.test(hash)) return false;
  return (GLASS_TABS as readonly string[]).includes(hash.slice(1)) || decisionFromHash(hash) !== null || reportFromHash(hash) !== null;
}

/** The report key a `/report/<key>` page path names, else null. */
export function reportFromPath(pathname: string): string | null {
  const m = /^\/report\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** Where a report's markdown and images are served (glass.ts serveReport). */
export const reportMarkdownUrl = (key: string): string => `/report/${encodeURIComponent(key)}/md`;
export const reportFileUrl = (key: string, name: string): string => `/report/${encodeURIComponent(key)}/files/${encodeURIComponent(name)}`;

/** History the page paged in from `/data/older`, newest first per kind. */
export interface GlassOlder {
  dispatches: GlassDispatchSummary[];
  notices: Notice[];
  prs: GlassPr[];
  stacks: GlassStack[];
}
export const NO_OLDER: GlassOlder = { dispatches: [], notices: [], prs: [], stacks: [] };

/** Add a page of history, skipping what is there already. */
export function addOlder(o: GlassOlder, page: GlassOlderPage): GlassOlder {
  if (page.kind === 'dispatches') {
    const seen = new Set(o.dispatches.map((x) => x.lane + ':' + x.id));
    return { ...o, dispatches: [...o.dispatches, ...page.items.filter((x) => !seen.has(x.lane + ':' + x.id))] };
  }
  if (page.kind === 'notices') {
    const seen = new Set(o.notices.map((n) => n.seq));
    return { ...o, notices: [...o.notices, ...page.items.filter((n) => !seen.has(n.seq))] };
  }
  const seen = new Set(o.prs.map((p) => p.key));
  const stacks = new Set(o.stacks.map((s) => s.id));
  return {
    ...o,
    prs: [...o.prs, ...page.items.filter((p) => !seen.has(p.key))],
    stacks: [...o.stacks, ...page.stacks.filter((s) => !stacks.has(s.id))],
  };
}

/** The snapshot with paged-in history after its own records; the poll's copy of a record wins. */
export function withOlder(d: GlassSnapshot, o: GlassOlder): GlassSnapshot {
  if (o === NO_OLDER || (!o.dispatches.length && !o.notices.length && !o.prs.length)) return d;
  const ids = new Set(d.dispatches.map((x) => x.lane + ':' + x.id));
  const seqs = new Set(d.notices.map((n) => n.seq));
  const keys = new Set(d.prs.map((p) => p.key));
  const stackIds = new Set(d.stacks.map((s) => s.id));
  return {
    ...d,
    dispatches: [...d.dispatches, ...o.dispatches.filter((x) => !ids.has(x.lane + ':' + x.id))],
    notices: [...d.notices, ...o.notices.filter((n) => !seqs.has(n.seq))],
    prs: [...d.prs, ...o.prs.filter((p) => !keys.has(p.key))],
    stacks: [...d.stacks, ...o.stacks.filter((s) => !stackIds.has(s.id))],
  };
}

/** How many records of a kind are still left out after what the page paged in. */
export function olderLeft(d: GlassSnapshot, o: GlassOlder, kind: GlassOlderKind): number {
  return Math.max(0, (d.older?.[kind] ?? 0) - o[kind].length);
}

/** A 304's beats: the snapshot the page holds, with the server time and heartbeats that ticked. */
export function applyBeats(d: GlassSnapshot, b: GlassBeats): GlassSnapshot {
  return {
    ...d,
    now: b.now,
    daemon: d.daemon && b.daemon !== undefined ? { ...d.daemon, heartbeat: b.daemon } : d.daemon,
    helms: d.helms.map((h) => (b.helms[h.grounds] !== undefined ? { ...h, heartbeatAt: b.helms[h.grounds]! } : h)),
    traps: d.traps.map((t) => (b.traps[t.trapId] ? { ...t, ...b.traps[t.trapId] } : t)),
  };
}

export function isStale(iso: string | undefined, ms: number, now: number): boolean {
  return !!iso && now - Date.parse(iso) > ms;
}

type Filterable = Pick<GlassDispatchSummary, 'id' | 'lane' | 'repo' | 'verb' | 'note' | 'title' | 'for'>;
export function matches(x: Filterable, st: Partial<GlassPrefs>): boolean {
  if (st.lane && x.lane !== st.lane) return false;
  if (st.repo && x.repo !== st.repo) return false;
  if (st.verb && x.verb !== st.verb) return false;
  if (st.q) {
    const q = st.q.toLowerCase();
    if (!(x.id + ' ' + (x.note || '') + ' ' + (x.title || '') + ' ' + (x.repo || '') + ' ' + (x.for || '')).toLowerCase().includes(q))
      return false;
  }
  return true;
}

/** The open dispatch modal's detail (`/data/dispatch/<id>`): loading, loaded, or failed. */
export interface DispatchDetail {
  /** The modal key it is for: `<lane>:<id>`. */
  key: string;
  data?: GlassDispatch;
  error?: string;
}

export function modalItem(d: GlassSnapshot, modal: ModalRef | null, detail?: DispatchDetail | null): ModalItem | null {
  if (!modal) return null;
  if (modal.type === 'helm') return d.helms.find((v) => v.grounds === modal.key) || null;
  if (modal.type === 'dispatch') {
    const summary = d.dispatches.find((v) => v.lane + ':' + v.id === modal.key);
    const full = detail && detail.key === modal.key ? detail.data : undefined;
    // The detail has the brief, log, and whole note; the summary keeps its PR badges.
    return summary && full ? { ...summary, ...full } : (summary ?? full ?? null);
  }
  if (modal.type === 'pr') return (d.prs || []).find((v) => v.key === modal.key) || null;
  if (modal.type === 'settings') return { attentionKinds: d.attentionKinds || [], attentionError: d.attentionError };
  const t = d.traps.find((v) => v.trapId === modal.key);
  return t ? trapView(d, t) : null;
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
  inflight: GlassDispatchSummary[];
  traps: Seat<GlassTrapView>[];
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
  chips: { daemon: GlassSnapshot['daemon']; daemonStale: boolean; helms: Seat<GlassHelm>[]; stats: GlassSnapshot['stats'] };
  deck: DeckInputs;
  dispatches: { view: GlassPrefs['view'] | undefined; chain: boolean | undefined; list: GlassDispatchSummary[] };
  traps: { view: GlassPrefs['view'] | undefined; list: Seat<GlassTrapView>[] };
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
  const item = modalItem(d, ui.modal, ui.detail);
  const recent = (iso: string | undefined, ms: number) => !!iso && now - Date.parse(iso) <= ms;
  // A signed-on trap keeps its seat through heartbeat, claim, and listening
  // changes. Signed-off traps follow in most-recently-signed-off order.
  const signedOffAt = (t: GlassTrap) =>
    Math.max(0, ...(t.notices || []).filter((n) => n.kind === 'trap-stowed' || n.kind === 'trap-ghosted').map((n) => Date.parse(n.at) || 0));
  const seated = (t: GlassTrap) => t.live || !!t.starting || !!t.requested;
  const orderedTraps = [...(d.traps || [])].sort((a, b) =>
    Number(seated(b)) - Number(seated(a)) ||
    Number(b.live) - Number(a.live) ||
    (a.live ? (Date.parse(a.signedOnAt || '') || 0) - (Date.parse(b.signedOnAt || '') || 0)
      : signedOffAt(b) - signedOffAt(a)) ||
    (a.name ?? a.trapId).localeCompare(b.name ?? b.trapId));
  const deckTraps = orderedTraps
    .filter(
      (t) =>
        (seated(t) || (t.notices || []).some((n) => (n.kind === 'trap-stowed' || n.kind === 'trap-ghosted') && recent(n.at, 3600000))) &&
        hasQuery(t.name, t.trapId, t.repo, t.worktree),
    );
  const noAge = ({ ageSecs, ...a }: TendAttention): DeckAttention => a;
  return {
    chips: { daemon: d.daemon, daemonStale: !!d.daemon && isStale(d.daemon.heartbeat, STALE_DAEMON_MS, now), helms: d.helms.map(seat), stats: d.stats },
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
      traps: deckTraps.map((t) => seat(trapView(d, t))),
      stacks: (d.stacks || []).filter((s) => s.open && hasQuery(s.repo, s.numbers.join(' '))),
      prs: (d.prs || []).filter((p) => p.state === 'OPEN'),
      error: d.attentionError,
    },
    dispatches: { view: st.view, chain: st.chain, list: d.dispatches.filter((x) => matches(x, st)) },
    traps: {
      view: st.view,
      list: orderedTraps
        .filter((t) => (!st.repo || t.repo === st.repo) && hasQuery(t.name, t.trapId, t.repo, t.worktree, t.harness))
        .map((t) => seat(trapView(d, t))),
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

/** The decisions the modal steps through: open ones (not answered from this page), oldest first. */
export function openDecisionOrder(cards: readonly DecisionCard[], sent: (key: string) => boolean): DecisionCard[] {
  return cards.filter((c) => !sent(c.key)).sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

/** The open decisions not yet viewed, oldest first: what the new-decision alert counts. */
export function unreadDecisions(cards: readonly DecisionCard[], sent: (key: string) => boolean, viewedHere: (key: string) => boolean): DecisionCard[] {
  return openDecisionOrder(cards, sent).filter((c) => !c.viewedAt && !viewedHere(c.key));
}
