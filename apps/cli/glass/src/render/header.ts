import type { GlassSnapshot } from '@lobstah/core';
import type { GlassTab, SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Html } from '../html.js';
import { st } from '../prefs.js';
import { ageEl } from './common.js';

/** The header and footer: the daemon and helm chips, the clock, the filter controls, the version line. */

export function renderChips(d: GlassSnapshot, chips: SectionInputs['chips']): Html {
  const hbOld = chips.daemonStale;
  const daemon = d.daemon
    ? html`<span class="${hbOld ? 'bad' : 'ok'}">${hbOld && 'stale '}${ageEl(d.daemon.heartbeat)} ago</span> <span class="dim">v${d.daemon.version}</span>`
    : html`<span class="bad">down</span>`;
  const helms = chips.helms.map(
    ({ x: h, stale }) =>
      html`<span class="chip click" onclick="showModal('helm','${h.grounds}')">⛵ <b>${h.man}</b> <span class="dim">helm ${h.grounds}</span> <span class="${stale ? 'warn' : 'ok'}">${stale && 'stale '}${ageEl(h.heartbeatAt)} ago</span></span>`,
  );
  return html`<span class="chip">daemon ${daemon}</span>${helms}`;
}

export const renderFoot = (d: GlassSnapshot): Html =>
  html`🦞✨ lobstah v${d.version} · <a href="${d.repoUrl}" target="_blank">${d.repoUrl.replace('https://github.com/', '')}</a>`;

const setText = (el: HTMLElement, t: string) => {
  if (el.textContent !== t) el.textContent = t;
};

/** The controls row: which filters the tab uses, the clock, and the repo and kind options. */
export function renderControls(d: GlassSnapshot, tab: GlassTab): void {
  document.getElementById('f-lane')!.style.display = tab === 'dispatches' ? '' : 'none';
  document.getElementById('f-verb')!.style.display = tab === 'dispatches' ? '' : 'none';
  document.getElementById('chain-control')!.style.display = tab === 'dispatches' ? '' : 'none';
  document.getElementById('f-kind')!.style.display = tab === 'notices' ? '' : 'none';
  setText(document.getElementById('clock')!, new Date(d.now).toLocaleTimeString('en-GB'));
  const repos = [
    ...new Set([...d.dispatches.map((x) => x.repo), ...d.notices.map((x) => x.repo), ...d.prs.map((x) => x.repo)].filter(Boolean)),
  ].sort();
  const rsel = document.getElementById('f-repo') as HTMLSelectElement;
  if (rsel.options.length !== repos.length + 1) {
    const cur = st.repo;
    rsel.innerHTML =
      html`<option value="">all repos</option>${repos.map((r) => html`<option${r === cur && ' selected'}>${r}</option>`)}`.value;
  }
  const kinds = [...new Set(d.notices.map((n) => n.kind))].sort(),
    ksel = document.getElementById('f-kind') as HTMLSelectElement;
  if (ksel.options.length !== kinds.length + 1)
    ksel.innerHTML =
      html`<option value="">all notice kinds</option>${kinds.map((k) => html`<option${k === st.noticeKind && ' selected'}>${k}</option>`)}`.value;
}
