import type { GlassTrap } from '@lobstah/core';
import { html } from '../html.js';
import type { Html } from '../html.js';
import { mailCell, openTrap, table, trapRow } from './common.js';

/** The Traps tab: live seats and the history of signed-off ones. */

export function trapTable(list: GlassTrap[]): Html {
  const row = (t: GlassTrap) => {
    const r = trapRow(t);
    return html`<tr class="rowhead${t.live ? '' : ' dim'}" onclick="${openTrap(t.trapId)}"><td><b>wt:${t.trapId}</b></td><td>${t.repo ?? '—'}</td><td class="grow">${t.worktree ?? ''}</td><td>${t.harness ?? ''}</td><td>${(t.sessionId ?? '').slice(0, 8)}</td><td>${r.listen}</td><td>${r.hb}</td><td>${mailCell(t)}</td><td>${t.catches.length}</td></tr>`;
  };
  return table(
    ['address', 'repo', 'worktree', 'harness', 'session', 'listening', 'heartbeat', 'mail', 'catches'],
    list.map(row),
    'no traps soaking',
  );
}

export function trapCards(list: GlassTrap[]): Html {
  if (!list.length) return html`<div class="empty">no traps soaking</div>`;
  const card = (t: GlassTrap) => {
    const r = trapRow(t);
    const mail = mailCell(t);
    const meta = html`${t.repo ?? (t.live ? 'addressed bait only' : 'history')}${t.sessionId && html` · session ${t.sessionId.slice(0, 8)}`}`;
    const foot = html`${r.listen}${t.live && html` · heartbeat ${r.hb}`} · ${t.catches.length} catch${t.catches.length === 1 ? '' : 'es'}${mail.value && html` · ${mail}`}`;
    return html`<div class="card${t.live ? '' : ' dim'}" onclick="${openTrap(t.trapId)}"><div class="top"><b>🪤 wt:${t.trapId}</b><span class="badge">${t.harness ?? (t.live ? '' : 'signed off')}</span></div><div class="meta">${meta}</div>${t.worktree && html`<div class="note">${t.worktree}</div>`}<div class="foot">${foot}</div></div>`;
  };
  return html`<div class="cards">${list.map(card)}</div>`;
}
