import type { GlassDispatchSummary, GlassHelm, GlassSnapshot } from '@lobstah/core';
import { modalItem } from '../../src/glass-diff.js';
import type { DispatchDetail, GlassPrefs, ModalRef, GlassTrapView as GlassTrap } from '../../src/glass-diff.js';
import { closeModal, setPrefs } from '../actions.js';
import { html } from '../html.js';
import { Age, WorkerDetails, cmdRow, resumeRow } from './common.js';
import { visibleTabs } from '../backend.js';
import { TAB_ICON } from './icons.js';
import { PrView } from './pr-view.js';
import { DispatchView } from './dispatch-view.js';
import { TrapView } from './trap-view.js';
import { DetailFrame } from './detail-frame.js';
import { Button } from './button.js';

/** The overlay's one modal: dispatch, trap, helm, PR or report. */

/**
 * The glass's own settings, for this device and this view: cards or table,
 * and the crawling lobs. lobstah's settings (the daemon, grounds and
 * config.toml, attention kinds and helm chat among them) are Configuration,
 * which it links to where this page has it.
 */
export function SettingsBody({ prefs }: { prefs: GlassPrefs }) {
  const viewOptions = html`<span class="seg" role="group" aria-label="view">${(['table', 'cards'] as const).map((view) => html`<${Button} pressed=${view === prefs.view} onClick=${() => setPrefs({ view })}>${view}<//>`)}</span>`;
  const lobOptions = html`<span class="seg" role="group" aria-label="lobs">${([true, false] as const).map((lobs) => html`<${Button} pressed=${lobs === prefs.lobs} onClick=${() => setPrefs({ lobs })}>${lobs ? 'on' : 'off'}<//>`)}</span>`;
  return html`<div class="settings"><div class="row"><span class="lbl">view<span class="hint">this device · cards or table</span></span>${viewOptions}</div><div class="row"><span class="lbl">lobs<span class="hint">this device · crawling lobsters</span></span>${lobOptions}</div></div>${
    visibleTabs().includes('settings') &&
    html`<p class="dim settings-config">Daemon and grounds settings are in <a href="#settings" onClick=${closeModal}>${TAB_ICON.settings}Configuration</a></p>`
  }`;
}

export function HelmBody({ helm: h }: { helm: GlassHelm }) {
  const sessionRow = h.sessionId ? resumeRow(h) : null;
  const stale = Date.now() - Date.parse(h.heartbeatAt) > 1800000;
  return [
    html`<div class="sub">helm of <b>${h.grounds}</b> (${(h.repos || []).join(', ')})</div><div class="sub">${h.cwd ?? '?'}${h.host && ' · ' + h.host}</div><div class="sub">session ${h.sessionId ?? ''} · signed on ${Age(h.signedOnAt)} ago · heartbeat <span class=${stale ? 'warn' : 'ok'}>${Age(h.heartbeatAt)} ago</span></div>`,
    html`<${WorkerDetails} worker=${h} />`,
    sessionRow && [html`<div class="sec">open this session</div>`, sessionRow],
    h.transcript && [html`<div class="sec">transcript</div>`, cmdRow(h.transcript)],
  ];
}

/** The open modal's body, or nothing. Preact keeps every unchanged node across ticks. */
export function Modal({
  snapshot,
  modal,
  prefs,
  detail = null,
}: {
  snapshot: GlassSnapshot | undefined;
  modal: ModalRef | null;
  prefs: GlassPrefs;
  detail?: DispatchDetail | null;
}) {
  if (!snapshot || !modal) return null;
  const item = modalItem(snapshot, modal, detail);
  // A dispatch the poll left out: its detail is on its way.
  if (!item && modal.type === 'dispatch' && detail?.key === modal.key)
    return html`<${DetailFrame} identity=${modal.key.slice(modal.key.indexOf(':') + 1, modal.key.indexOf(':') + 9)}><p class=${detail.error ? 'bad' : 'dim'}>${detail.error ?? 'Loading dispatch…'}</p><//>`;
  if (!item) return null;
  // Settings open in a Dialog of their own (app.ts).
  if (modal.type === 'settings') return null;
  if (modal.type === 'pr') return html`<${PrView} snapshot=${snapshot} prKey=${modal.key} />`;
  if (modal.type === 'review') return html`<${PrView} snapshot=${snapshot} prKey=${modal.key.replace('review:', 'pr:')} />`;
  if (modal.type === 'helm') return null;
  if (modal.type === 'dispatch') {
    return html`<${DispatchView} snapshot=${snapshot} dispatch=${item as GlassDispatchSummary} detail=${detail} />`;
  }
  return html`<${TrapView} trap=${item as GlassTrap} snapshot=${snapshot} />`;
}
