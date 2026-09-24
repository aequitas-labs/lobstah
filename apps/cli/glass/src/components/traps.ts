import type { GlassTrap } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import { Table, mailCell, opener, trapRow } from './common.js';

/** The Traps tab: live seats and the history of signed-off ones. */

function row(t: GlassTrap) {
  const r = trapRow(t);
  return html`<tr key=${t.trapId} class=${'rowhead' + (t.live ? '' : ' dim')} onClick=${opener('trap', t.trapId)}><td><b>wt:${t.trapId}</b></td><td>${t.repo ?? '—'}</td><td class="grow">${t.worktree ?? ''}</td><td>${t.harness ?? ''}</td><td>${(t.sessionId ?? '').slice(0, 8)}</td><td>${r.listen}</td><td>${r.hb}</td><td>${mailCell(t)}</td><td>${t.catches.length}</td></tr>`;
}

function card(t: GlassTrap) {
  const r = trapRow(t);
  const mail = mailCell(t);
  return html`<div key=${t.trapId} class=${'card' + (t.live ? '' : ' dim')} onClick=${opener('trap', t.trapId)}><div class="top"><b>🪤 wt:${t.trapId}</b><span class="badge">${t.harness ?? (t.live ? '' : 'signed off')}</span></div><div class="meta">${t.repo ?? (t.live ? 'addressed bait only' : 'history')}${t.sessionId && ' · session ' + t.sessionId.slice(0, 8)}</div>${t.worktree && html`<div class="note">${t.worktree}</div>`}<div class="foot">${r.listen}${t.live && [' · heartbeat ', r.hb]} · ${t.catches.length} catch${t.catches.length === 1 ? '' : 'es'}${mail && [' · ', mail]}</div></div>`;
}

export function Traps({ inp }: { inp: SectionInputs['traps'] }) {
  const list = inp.list.map((t) => t.x);
  if (inp.view === 'cards')
    return list.length ? html`<div class="cards">${list.map(card)}</div>` : html`<div class="empty">no traps soaking</div>`;
  return Table(
    ['address', 'repo', 'worktree', 'harness', 'session', 'listening', 'heartbeat', 'mail', 'catches'],
    list.map(row),
    'no traps soaking',
  );
}
