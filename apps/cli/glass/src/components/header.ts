import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_TABS } from '../../../src/glass-diff.js';
import type { GlassPrefs, GlassTab, SectionInputs } from '../../../src/glass-diff.js';
import { setPrefs, showModal } from '../actions.js';
import { html } from '../html.js';
import { Age, opener } from './common.js';

/** The header: the title and ⚙, the daemon and helm chips and clock, the tabs, and the filter controls. */

const TAB_LABEL: Record<GlassTab, string> = { deck: 'On deck', dispatches: 'Dispatches', traps: 'Traps', prs: 'PRs', notices: 'Notices' };
const VERBS = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'unknown'];

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
    inp.helms.map(
      ({ x: h, stale }) =>
        html`<span key=${h.grounds} class="chip click" onClick=${opener('helm', h.grounds)}>⛵ <b>${h.man}</b> <span class="dim">helm ${h.grounds}</span> <span class=${stale ? 'warn' : 'ok'}>${stale && 'stale '}${Age(h.heartbeatAt)} ago</span></span>`,
    ),
  ];
}

/**
 * The repo options are rebuilt only when their count changes — the old
 * page's behavior, kept: a repo list that swaps one name for another at the
 * same count keeps the options it had.
 */
let repoOptions: string[] = [];
function repoList(d: GlassSnapshot): string[] {
  const repos = [
    ...new Set(
      [...d.dispatches.map((x) => x.repo), ...d.notices.map((x) => x.repo), ...d.prs.map((x) => x.repo)].filter(Boolean) as string[],
    ),
  ].sort();
  if (repos.length !== repoOptions.length) repoOptions = repos;
  return repoOptions;
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
  return html`<div class="controls">
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

export function Header({
  d,
  inp,
  tab,
  st,
  stale,
}: {
  d: GlassSnapshot | undefined;
  inp: SectionInputs | undefined;
  tab: GlassTab;
  st: GlassPrefs;
  stale: boolean;
}) {
  return [
    html`<div class="headerline"><h1>🦞✨ spyglass<span id="stale" style=${d || stale ? (stale ? 'display:inline' : 'display:none') : undefined}> · STALE FEED</span></h1><span id="settings-slot"><button id="gearbtn" title="settings" aria-label="settings" onClick=${() => showModal('settings', 'browser')}>⚙</button></span></div>`,
    html`<div class="chips"><span id="chips" style="display:contents">${d && inp && chips(d, inp.chips)}</span><span class="chip dim" id="clock">${d && new Date(d.now).toLocaleTimeString('en-GB')}</span></div>`,
    html`<nav class="tabs" id="tabs" aria-label="Spyglass views">${GLASS_TABS.map((t) => html`<a href=${'#' + t} data-tab=${t} class=${d ? (t === tab ? 'on' : '') : undefined}>${TAB_LABEL[t]}</a>`)}</nav>`,
    controls(d, tab, st),
  ];
}

export const Footer = ({ d }: { d: GlassSnapshot | undefined }) =>
  d && [
    '🦞✨ lobstah v' + d.version + ' · ',
    html`<a href=${d.repoUrl} target="_blank">${d.repoUrl.replace('https://github.com/', '')}</a>`,
  ];
