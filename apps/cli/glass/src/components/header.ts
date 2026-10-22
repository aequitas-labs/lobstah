import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_TABS } from '../../../src/glass-diff.js';
import type { GlassPrefs, GlassTab, SectionInputs } from '../../../src/glass-diff.js';
import { setPrefs, showModal } from '../actions.js';
import { html } from '../html.js';
import { Age, Harness, opener } from './common.js';

/** The header: the title and ⚙, the daemon and helm chips and clock, the tabs, and the filter controls. */

const TAB_LABEL: Record<GlassTab, string> = {
  deck: 'On deck',
  dispatches: 'Dispatches',
  traps: 'Traps',
  prs: 'PRs',
  reviews: 'Reviews',
  reports: 'Reports',
  todos: 'TODOs',
  notices: 'Notices',
  stats: 'Stats',
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
    html`<span class="chip">daemon ${daemon}</span>`,
    (inp.backends?.some((b) => b.kind === 'wharf') ? inp.backends : []).map(
      (b) =>
        html`<span class=${b.unavailable ? 'chip warn' : 'chip dim'} title=${b.url ?? 'local files'}>${b.grounds} · ${b.wharf ?? 'local'}${b.unavailable ? ' · unknown' : ''}</span>`,
    ),
    inp.stats && html`<span class="chip" title="catches today">🦞 ${inp.stats.catchesToday} today</span>`,
    d.slots &&
      html`<span class="chip">active ${icon('🎣', 'headless')} ${d.slots.headless} of ${d.slots.limit}; ${icon('🪤', 'traps')} ${d.slots.traps}${d.slots.parked ? `; parked: ${d.slots.parked} (no slot)` : ''}</span>`,
    inp.helms.map(
      ({ x: h, stale }) =>
        html`<span key=${h.grounds} class="chip click" onClick=${opener('helm', h.grounds)}>⛵ <${Harness} worker=${h} label=${html`<b>${h.man}</b>`} cls="" /> <span class="dim">helm ${h.grounds} · chat ${h.chat ?? 'full'}</span> <span class=${stale ? 'warn' : 'ok'}>${stale && 'stale '}${Age(h.heartbeatAt)} ago</span></span>`,
    ),
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
  // The Stats tab has nothing to filter.
  return html`<div class="controls" style=${tab === 'stats' ? 'display:none' : undefined}>
    <select id="f-lane" style=${d && only('dispatches')} value=${st.lane} onChange=${(e: Event) => setPrefs({ lane: value(e) })}>
      <option value="">all lanes</option>
      <option value="work">work</option>
      <option value="chore">chore</option>
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

/** A disclosure with ordinary navigation links: Tab works without menu-specific keys. */
function Navigation({ d, tab, unread }: { d?: GlassSnapshot; tab: GlassTab; unread: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLAnchorElement>(`a[data-tab="${tab}"]`)?.focus();
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
      if (window.innerWidth >= 640) setOpen(false);
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
  const links = (mobile = false) =>
    GLASS_TABS.map(
      (t) =>
        html`<a href=${'#' + t} data-tab=${t} class=${d ? (t === tab ? 'on' : '') : undefined} aria-current=${mobile && t === tab ? 'page' : undefined} onClick=${mobile ? close : undefined}>${TAB_LABEL[t]}${badge(t)}</a>`,
    );
  return [
    html`<nav class="tabs" id="tabs" aria-label="Spyglass views">${links()}</nav>`,
    html`<div class="mobile-nav" ref=${root}><div class="mobile-nav-header"><span class="mobile-current">${TAB_LABEL[tab]}${badge(tab)}</span>${tab !== 'deck' && unread > 0 && html`<a class="mobile-unread" href="#deck" aria-label=${`On deck: ${unread} new decisions`}>On deck${badge('deck')}</a>`}<button ref=${toggle} type="button" class="nav-toggle" aria-label="Sections" aria-expanded=${open} aria-controls="mobile-sections" onClick=${() => (open ? close() : setOpen(true))}><span aria-hidden="true">☰</span></button></div>${open && html`<nav ref=${menu} id="mobile-sections" class="mobile-sections" aria-label="Spyglass sections">${links(true)}</nav>`}</div>`,
  ];
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
    html`<div class="headerline"><h1>🦞✨ spyglass<span id="stale" style=${d || stale ? (stale ? 'display:inline' : 'display:none') : undefined}> · STALE FEED</span></h1><span id="settings-slot"><button id="gearbtn" title="settings" aria-label="settings" onClick=${() => showModal('settings', 'browser')}>⚙</button></span></div>`,
    html`<div class="chips"><span id="chips" style="display:contents">${d && inp && chips(d, inp.chips)}</span><span class="chip dim" id="clock">${d && new Date(d.now).toLocaleTimeString('en-GB')}</span></div>`,
    html`<${Navigation} d=${d} tab=${tab} unread=${unread} />`,
    controls(d, tab, st),
  ];
}

export const Footer = ({ d }: { d: GlassSnapshot | undefined }) =>
  d && [
    '🦞✨ lobstah v' + d.version + ' · ',
    html`<a href=${d.repoUrl} target="_blank">${d.repoUrl.replace('https://github.com/', '')}</a>`,
  ];
