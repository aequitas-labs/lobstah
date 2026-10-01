import type { GlassTrapView as GlassTrap } from '../../../src/glass-diff.js';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { catchCount } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import {
  badgeLong,
  badgeTitle,
  mailCell,
  NewTrap,
  opener,
  startCommands,
  Table,
  trapNow,
  trapNowText,
  trapRow,
  windowAction,
} from './common.js';

/** The Traps tab: live seats, reserved (starting) ones, and the history of signed-off ones. */

/** A starting trap shows its state; a live one its harness. */
const badgeText = (t: GlassTrap): string =>
  t.requested
    ? 'requested'
    : t.starting
      ? t.starting.failedAt
        ? 'start failed'
        : 'starting'
      : (t.harness ?? (t.live ? '' : 'signed off'));
const dim = (t: GlassTrap): string => (t.live || t.starting ? '' : ' dim');

function row(t: GlassTrap) {
  const r = trapRow(t);
  return html`<tr key=${t.trapId} class=${'rowhead' + dim(t)} onClick=${opener('trap', t.trapId)}><td><b>${t.label ?? `wt:${t.trapId}`}</b></td><td>${t.repo ?? '—'}</td><td class="grow">${t.worktree ?? ''}</td><td>${t.harness ?? ''}</td><td>${(t.sessionId ?? '').slice(0, 8)}</td><td>${trapNow(t)}${startCommands(t)}</td><td>${r.listen}</td><td>${r.hb}</td><td>${mailCell(t)}</td><td class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</td><td>${windowAction(t)}</td></tr>`;
}

function card(t: GlassTrap) {
  const r = trapRow(t);
  const mail = mailCell(t);
  const meta = `${t.repo ?? (t.live ? 'addressed bait only' : 'history')}${t.sessionId ? ' · session ' + t.sessionId.slice(0, 8) : ''}`;
  return html`<div key=${t.trapId} class=${'card' + dim(t)} onClick=${opener('trap', t.trapId)}><div class="top"><b>🪤 ${t.label ?? `wt:${t.trapId}`}</b><span class=${'badge' + badgeLong(badgeText(t))} title=${badgeTitle(badgeText(t))}>${badgeText(t)}</span></div><div class="meta" title=${meta}>${meta}</div>${t.worktree && html`<div class="note" title=${t.worktree}>${t.worktree}</div>`}<div class="note" title=${trapNowText(t)}>${trapNow(t)}</div>${startCommands(t)}<div class="foot"><span>${r.listen}${t.live && [' · heartbeat ', r.hb]} · <span class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</span>${mail && [' · ', mail]}</span><span class="footact">${windowAction(t)}</span></div></div>`;
}

export function Traps({ inp }: { inp: SectionInputs['traps'] }) {
  const list = inp.list.map((t) => t.x);
  const head = html`<div class="tabhead"><${NewTrap} /></div>`;
  if (inp.view === 'cards')
    return [head, list.length ? html`<div class="cards">${list.map(card)}</div>` : html`<div class="empty">no traps soaking</div>`];
  return [
    head,
    Table(
      ['address', 'repo', 'worktree', 'harness', 'session', 'now', 'listening', 'heartbeat', 'mail', 'catches', 'window'],
      list.map(row),
      'no traps soaking',
    ),
  ];
}
