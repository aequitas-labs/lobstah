import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import logo from '../../../../docs/assets/favicon.png';
import type { GlassSnapshot } from '@lobstah/core';
import type { GlassPrefs, GlassTab, SectionInputs } from '../../src/glass-diff.js';
import { setPrefs, showModal } from '../actions.js';
import { html } from '../html.js';
import { GrantChip } from './session-grants.js';
import { Age, Harness, opener } from './common.js';
import { capabilities, visibleTabs } from '../backend.js';
import { host } from '../host.js';
import { getState } from '../store.js';
import { PrIcon } from './card.js';

/** The header: the title and ⚙, the daemon and helm chips and clock, the tabs, and the filter controls. */

const TAB_LABEL: Record<GlassTab, string> = {
  deck: 'On deck',
  dispatches: 'Dispatches',
  traps: 'Traps',
  boats: 'Boats',
  prs: 'PRs',
  reviews: 'Reviews',
  reports: 'Reports',
  grants: 'Grants',
  todos: 'TODOs',
  notices: 'Notices',
  stats: 'Stats',
  settings: 'Settings',
};
const VERBS = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'unknown'];

/** An emoji standing in for a word: screen readers and hover still say the word. */
const icon = (glyph: string, word: string) => html`<span role="img" aria-label=${word} title=${word}>${glyph}</span>`;

function chips(d: GlassSnapshot, inp: SectionInputs['chips']) {
  const hbOld = inp.daemonStale;
  const daemon = d.daemon
    ? [
        html`<span class=${hbOld ? 'bad' : 'ok'}>${hbOld && 'stale '}${Age(d.daemon.heartbeat)} ago</span>`,
        ' ',
        html`<span class="dim">v${d.daemon.version}</span>`,
      ]
    : html`<span class="bad">down</span>`;
  return [
    // A daemon on this machine: its heartbeat. A wharf has none, so it shows none.
    capabilities().daemon && html`<span class="chip">daemon ${daemon}</span>`,
    (inp.backends?.some((b) => b.kind === 'wharf') ? inp.backends : []).map(
      (b) =>
        html`<span class=${b.unavailable ? 'chip warn' : 'chip dim'} title=${b.url ?? 'local files'}>${b.grounds} · ${b.wharf ?? 'local'}${b.unavailable ? ' · unknown' : ''}</span>`,
    ),
    inp.stats && html`<span class="chip" title="catches today">🦞 ${inp.stats.catchesToday} today</span>`,
    d.slots &&
      html`<span class="chip">active ${icon('🎣', 'headless')} ${d.slots.headless} of ${d.slots.limit}; ${icon('🪤', 'traps')} ${d.slots.traps}${d.slots.parked ? `; parked: ${d.slots.parked} (no slot)` : ''}</span>`,
    d.heavy &&
      d.heavy.tickets.length > 0 &&
      html`<span class="chip" title="The machine's line for heavy commands">heavy ${d.heavy.running}/${d.heavy.slots}${d.heavy.waiting ? ` · ${d.heavy.waiting} waiting` : ''}</span>`,
    inp.helms.map(
      ({ x: h, stale }) =>
        html`<span key=${h.grounds} class="chip click" onClick=${opener('helm', h.grounds)}>⛵ <${Harness} worker=${h} label=${html`<b>${h.man}</b>`} cls="" /> <span class="dim">helm ${h.grounds} · chat ${h.chat ?? 'full'}</span> <span class=${stale ? 'warn' : 'ok'}>${stale && 'stale '}${Age(h.heartbeatAt)} ago</span><${GrantChip} session=${h.sessionId} grants=${d.sessionGrants} /></span>`,
    ),
    host().chips?.(),
  ];
}

/** Configured repos remain selectable even with no dispatches or PR work. */
function repoList(d: GlassSnapshot): string[] {
  return [
    ...new Set(
      [
        ...(d.repoKeys ?? []),
        ...Object.keys(d.reviewSetup?.perRepo ?? {}),
        ...(d.reviews ?? []).map((x) => x.repoKey),
        ...d.dispatches.map((x) => x.repo),
        ...d.notices.map((x) => x.repo),
        ...d.prs.map((x) => x.repo),
      ].filter(Boolean) as string[],
    ),
  ].sort();
}
let kindOptions: string[] = [];
function kindList(d: GlassSnapshot): string[] {
  const kinds = [...new Set(d.notices.map((n) => n.kind))].sort();
  if (kinds.length !== kindOptions.length) kindOptions = kinds;
  return kindOptions;
}

const value = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;

function controls(d: GlassSnapshot | undefined, tab: GlassTab, st: GlassPrefs) {
  const only = (t: GlassTab) => (tab === t ? '' : 'display:none');
  const repos = d ? repoList(d) : [];
  const kinds = d ? kindList(d) : [];
  // These tabs have nothing to filter.
  return html`<div class=${'controls tab-' + tab} style=${tab === 'stats' || tab === 'grants' || tab === 'settings' ? 'display:none' : undefined}>
    <select id="f-lane" style=${d && only('dispatches')} value=${st.lane} onChange=${(e: Event) => setPrefs({ lane: value(e) })}>
      <option value="">all dispatches</option>
      <option value="work">work</option>
      <option value="chore">chores</option>
    </select>
    <select id="f-repo" value=${st.repo} onChange=${(e: Event) => setPrefs({ repo: value(e) })}>
      <option value="">all repos</option>
      ${repos.map((r) => html`<option key=${r}>${r}</option>`)}
    </select>
    <select id="f-verb" style=${d && only('dispatches')} value=${st.verb} onChange=${(e: Event) => setPrefs({ verb: value(e) })}>
      <option value="">all verbs</option>
      ${VERBS.map((v) => html`<option key=${v}>${v}</option>`)}
    </select>
    <label id="chain-control" style=${d && only('dispatches')}><input id="f-chain" type="checkbox" checked=${!!st.chain} onChange=${(e: Event) => setPrefs({ chain: (e.currentTarget as HTMLInputElement).checked })} /> group by chain</label>
    <select id="f-kind" style=${d && only('notices')} value=${st.noticeKind} onChange=${(e: Event) => setPrefs({ noticeKind: value(e) })}>
      <option value="">all notice kinds</option>
      ${kinds.map((k) => html`<option key=${k}>${k}</option>`)}
    </select>
    <input id="f-q" type="search" placeholder="search id · note · brief" value=${st.q} onInput=${(e: Event) => setPrefs({ q: value(e) })} />
  </div>`;
}

/** Always in the bar. The other tabs join them where the screen fits every tab on one line (glass.css), else sit behind More. */
const PINNED: readonly GlassTab[] = ['deck', 'reviews'];
/** glass.css's breakpoint: from this width every tab is inline and More is hidden. */
const ALL_TABS_FIT = '(min-width: 900px)';

/** The tab bar, and More: a disclosure with ordinary navigation links, so Tab works without menu-specific keys. */
function Navigation({ d, tab, unread }: { d?: GlassSnapshot; tab: GlassTab; unread: number }) {
  const [open, setOpen] = useState(false);
  const tabs = visibleTabs();
  const moreTabs = tabs.filter((t) => !PINNED.includes(t));
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  useLayoutEffect(() => {
    if (open)
      (
        menu.current?.querySelector<HTMLAnchorElement>(`a[data-tab="${tab}"]`) ?? menu.current?.querySelector<HTMLAnchorElement>('a')
      )?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    const resize = () => {
      if (window.matchMedia(ALL_TABS_FIT).matches) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    window.addEventListener('hashchange', close);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('hashchange', close);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const badge = (t: GlassTab) => {
    const count = t === 'deck' ? unread : t === 'reviews' ? (d?.reviews ?? []).filter((r) => r.stands || r.notification).length : 0;
    return (
      count > 0 &&
      html`<span class="dbadge" aria-label=${t === 'deck' ? `${count} new decision${count === 1 ? '' : 's'}` : 'reviews in inbox'}>${count}</span>`
    );
  };
  const link = (t: GlassTab, inMenu = false) =>
    html`<a href=${'#' + t} data-tab=${t} class=${d ? (t === tab ? 'on' : '') : undefined} aria-current=${inMenu && t === tab ? 'page' : undefined} onClick=${inMenu ? close : undefined}>${TAB_LABEL[t]}${badge(t)}</a>`;
  // With the active tab behind More, More carries the active tab's underline.
  const here = moreTabs.includes(tab);
  return html`<div class="navbar" ref=${root}>
    <nav class="tabs" id="tabs" aria-label="Spyglass views">${tabs.map((t) => link(t))}</nav>
    <button ref=${toggle} type="button" class=${here ? 'nav-toggle on' : 'nav-toggle'} aria-label="More" aria-expanded=${open} aria-controls="more-sections" onClick=${() => (open ? close() : setOpen(true))}><span aria-hidden="true">☰</span></button>
    ${open && html`<nav ref=${menu} id="more-sections" class="more-sections" aria-label="Spyglass sections">${moreTabs.map((t) => link(t, true))}</nav>`}
  </div>`;
}

/**
 * On a phone (glass.css, under 700px) the header is the name and the helm
 * pill, then one strip of the fleet's numbers; the tabs, chips and filters
 * give way to a bar at the bottom: On deck, Reviews, Search and Menu. Wider
 * screens never show these parts.
 */

/** The helm as a pill: a dot (amber when its heartbeat is stale or a mirror boat is asleep), its name and its age. */
function HelmPill({ inp }: { inp: SectionInputs['chips'] }) {
  const asleep = host().asleep?.() ?? false;
  return inp.helms.map(
    ({ x: h, stale }) =>
      html`<button key=${h.grounds} type="button" class="helmpill" onClick=${opener('helm', h.grounds)} title=${asleep ? 'a boat is asleep: its rows are read-only' : `helm ${h.grounds}`}><span class=${'hdot ' + (stale || asleep ? 'warn' : 'ok')} aria-hidden="true"></span><b>${h.man}</b> <span class="dim">${Age(h.heartbeatAt)}</span></button>`,
  );
}

/** One line of the fleet's numbers: catches today, traps, slots in use, the heavy line. */
function Strip({ d, inp }: { d: GlassSnapshot; inp: SectionInputs['chips'] }) {
  const parts = [
    inp.stats && html`<span title="catches today">🦞 ${inp.stats.catchesToday} today</span>`,
    d.slots && html`<span title="traps">🪤 ${d.slots.traps} ${d.slots.traps === 1 ? 'trap' : 'traps'}</span>`,
    d.slots && html`<span title="headless slots in use">🎣 ${d.slots.headless} of ${d.slots.limit}</span>`,
    d.heavy &&
      d.heavy.tickets.length > 0 &&
      html`<span title="The machine's line for heavy commands">heavy ${d.heavy.running}/${d.heavy.slots}${d.heavy.waiting ? ` +${d.heavy.waiting}` : ''}</span>`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return html`<div class="phone-strip">${parts.flatMap((p, i) => (i ? [html`<span class="dim" aria-hidden="true"> · </span>`, p] : [p]))}</div>`;
}

const svg = (body: string) =>
  html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: body }}></svg>`;
const DECK_ICON = svg(
  '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
);
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>');
const MENU_ICON = svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>');

/** The bar at the bottom of a phone: On deck and Reviews, then Search and Menu. */
function BottomBar({ d, inp, tab, st, unread }: { d?: GlassSnapshot; inp?: SectionInputs; tab: GlassTab; st: GlassPrefs; unread: number }) {
  const [mode, setMode] = useState<'bar' | 'search' | 'menu'>('bar');
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (mode === 'search') search.current?.focus();
    if (mode !== 'menu') return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMode('bar');
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMode('bar');
    };
    const away = () => setMode('bar');
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    window.addEventListener('hashchange', away);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('hashchange', away);
    };
  }, [mode]);
  // A decision or run card takes the bottom edge with its own dock.
  if (getState().decisionModal) return null;
  const reviews = (d?.reviews ?? []).filter((r) => r.stands || r.notification).length;
  const count = (n: number, label: string) => n > 0 && html`<span class="dbadge" aria-label=${label}>${n}</span>`;
  if (mode === 'search') {
    const repos = d ? repoList(d) : [];
    const chip = (repo: string, label: string) =>
      html`<button key=${repo || '*'} type="button" class=${'repochip' + (st.repo === repo ? ' on' : '')} aria-pressed=${st.repo === repo} onClick=${() => setPrefs({ repo })}>${label}</button>`;
    return html`<div class="bottombar searching" ref=${root}>
      <div class="repochips" aria-label="repos">${chip('', 'all repos')}${repos.map((r) => chip(r, r))}</div>
      <div class="bbrow"><input ref=${search} type="search" aria-label="search" placeholder="search id · note · brief" value=${st.q} onInput=${(e: Event) => setPrefs({ q: value(e) })} /><button type="button" class="bbclose" aria-label="close search" onClick=${() => setMode('bar')}>✕</button></div>
    </div>`;
  }
  const tabs = visibleTabs();
  const link = (t: GlassTab, icon: unknown, badge: unknown) =>
    tabs.includes(t) &&
    html`<a href=${'#' + t} class=${'bbitem' + (t === tab ? ' on' : '')} aria-current=${t === tab ? 'page' : undefined}><span class="bbicon">${icon}${badge}</span><span class="bblabel">${TAB_LABEL[t]}</span></a>`;
  const fleet = d && inp && [capabilities().daemon && chips(d, inp.chips)[0], host().fleet?.()];
  return html`<div class="bottombar" ref=${root}>
    ${
      mode === 'menu' &&
      html`<div class="phonemenu" id="phone-menu" role="menu" aria-label="Spyglass menu">
        <div class="pmsec">views</div>
        <nav aria-label="Spyglass views">${tabs.map((t) => html`<a key=${t} href=${'#' + t} role="menuitem" class=${t === tab ? 'on' : ''} aria-current=${t === tab ? 'page' : undefined} onClick=${() => setMode('bar')}>${TAB_LABEL[t]}</a>`)}</nav>
        ${fleet && html`<div class="pmsec">fleet</div><div class="pmchips">${fleet}</div>`}
        <div class="pmsec">you</div>
        <div class="pmyou"><button type="button" class="btn" role="menuitem" onClick=${() => {
          setMode('bar');
          showModal('settings', 'browser');
        }}>⚙ settings</button>${host().signOut && html`<button type="button" class="btn" role="menuitem" onClick=${() => host().signOut!()}>Sign out</button>`}</div>
      </div>`
    }
    <nav class="bbrow" aria-label="Spyglass">
      ${link('deck', DECK_ICON, count(unread, `${unread} new decision${unread === 1 ? '' : 's'}`))}
      ${link('reviews', PrIcon, count(reviews, 'reviews in inbox'))}
      <button type="button" class=${'bbitem' + (st.q || st.repo ? ' on' : '')} onClick=${() => setMode('search')}><span class="bbicon">${SEARCH_ICON}</span><span class="bblabel">Search</span></button>
      <button type="button" class=${'bbitem' + (mode === 'menu' ? ' on' : '')} aria-expanded=${mode === 'menu'} aria-controls="phone-menu" onClick=${() => setMode(mode === 'menu' ? 'bar' : 'menu')}><span class="bbicon">${MENU_ICON}</span><span class="bblabel">Menu</span></button>
    </nav>
  </div>`;
}

export function Header({
  d,
  inp,
  tab,
  st,
  stale,
  unread = 0,
}: {
  d: GlassSnapshot | undefined;
  inp: SectionInputs | undefined;
  tab: GlassTab;
  st: GlassPrefs;
  stale: boolean;
  /** Unread decisions: a red badge on the deck tab, where they are listed. */
  unread?: number;
}) {
  return [
    html`<div class="headerline"><h1><img class="glass-brand" src=${logo} alt="lobstah" /> spyglass<span id="stale" style=${d || stale ? (stale ? 'display:inline' : 'display:none') : undefined}> · STALE FEED</span></h1>${d && inp && html`<span class="phone-helm"><${HelmPill} inp=${inp.chips} /></span>`}<span id="settings-slot"><button id="gearbtn" title="settings" aria-label="settings" onClick=${() => showModal('settings', 'browser')}>⚙</button></span></div>`,
    d && inp && html`<${Strip} d=${d} inp=${inp.chips} />`,
    html`<div class="chips"><span id="chips" style="display:contents">${d && inp && chips(d, inp.chips)}</span><span class="chip dim" id="clock">${d && new Date(d.now).toLocaleTimeString('en-GB')}</span></div>`,
    html`<${Navigation} d=${d} tab=${tab} unread=${unread} />`,
    controls(d, tab, st),
    html`<${BottomBar} d=${d} inp=${inp} tab=${tab} st=${st} unread=${unread} />`,
  ];
}

export const Footer = ({ d }: { d: GlassSnapshot | undefined }) =>
  d && [
    html`<img class="glass-brand" src=${logo} alt="" />`,
    d.version ? ` lobstah v${d.version} · ` : ` lobstah · ${host().footer ? host().footer + ' · ' : ''}`,
    html`<a href=${d.repoUrl} target="_blank">${d.repoUrl.replace('https://github.com/', '')}</a>`,
  ];
