import { HarnessIcon } from '../../../../../packages/glass-ui/ui/components/harness-icon.js';
import { validDesktopStartLink } from '../../../../../packages/core/src/desktop-start-link.js';
import type { Grant } from '@lobstah/core';
import { GrantChip } from './session-grants.js';
import type { GlassTrapView as GlassTrap } from '../../../src/glass-diff.js';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { catchCount } from '../../../src/glass-diff.js';
import { html } from '../../../../../packages/glass-ui/ui/html.js';
import {
  badgeLong,
  badgeTitle,
  Harness,
  mailCell,
  NewTrap,
  opener,
  startCommands,
  Table,
  trapNow,
  trapNowText,
  trapDisplayName,
  trapScope,
  trapRow,
  windowAction,
  DesktopStartAction,
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

function row(t: GlassTrap, grants: Grant[]) {
  const r = trapRow(t);
  return html`<tr key=${t.trapId} class=${'rowhead' + dim(t)} onClick=${opener('trap', t.trapId)}><td><b title=${`wt:${t.trapId}`}>${trapDisplayName(t)}</b><div class="trap-address dim">wt:${t.trapId}</div></td><td>${t.configured ? `trap:${t.configured.profile} · ${t.configured.grounds}` : (t.repo ?? '—')}</td><td class="grow">${t.worktree ?? ''}</td><td>${t.harness && html`<${Harness} worker=${t} cls="" compact />`}</td><td>${(t.sessionId ?? '').slice(0, 8)}<${GrantChip} session=${t.sessionId} grants=${grants} /></td><td>${trapNow(t)}${startCommands(t)}</td><td>${r.listen}</td><td>${r.hb}</td><td>${mailCell(t)}</td><td class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</td><td>${windowAction(t)}</td></tr>`;
}

function card(t: GlassTrap, grants: Grant[]) {
  const r = trapRow(t);
  const mail = mailCell(t);
  const meta = [
    t.configured
      ? `${t.configured.profile} · ${t.configured.grounds} · ${t.configured.surface}`
      : t.repo
        ? ''
        : t.live
          ? 'addressed bait only'
          : 'history',
    t.sessionId ? 'session ' + t.sessionId.slice(0, 8) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return html`<div key=${t.trapId} class=${'card' + dim(t)} onClick=${opener('trap', t.trapId)}><div class="top"><b title=${`wt:${t.trapId}`}>🪤 ${trapDisplayName(t)}</b>${!t.requested && !t.starting && t.harness ? html`<${Harness} worker=${t} compact />` : html`<span class=${'badge' + badgeLong(badgeText(t))} title=${badgeTitle(badgeText(t))}>${badgeText(t)}</span>`}</div><div class="meta" title=${meta}>${meta}<${GrantChip} session=${t.sessionId} grants=${grants} /></div>${t.worktree && html`<div class="note" title=${t.worktree}>${t.worktree}</div>`}<div class="note" title=${trapNowText(t)}>${trapNow(t)}</div>${startCommands(t)}<div class="foot"><span>${r.listen}${t.live && [' · heartbeat ', r.hb]} · <span class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</span>${mail && [' · ', mail]}</span></div><div class="foot"><span class="trap-scope" title=${trapScope(t)}>${trapScope(t)}</span><span class="footact">${windowAction(t)}</span></div></div>`;
}

export function Traps({ inp, grants = [] }: { inp: SectionInputs['traps']; grants?: Grant[] }) {
  const list = inp.list.map((t) => t.x);
  const head = html`<div class="tabhead"><${NewTrap} /></div>`;
  const configured = inp.configured?.length
    ? html`<div class="cards configured-traps">${inp.configured.map((profile) => html`<div class="card"><div class="top"><b>trap:${profile.profile}</b><span class="badge">${profile.state}</span></div><div class="meta">${profile.grounds} · <${HarnessIcon} harness=${profile.harness} /> · ${profile.surface} · ${profile.capacity}</div>${profile.cwd && html`<div class="note">${profile.cwd}</div>`}${profile.pending?.length && html`<div class="note">Queued: ${profile.pending.join(', ')}</div>`}${profile.start && validDesktopStartLink(profile.start.url) && html`<${DesktopStartAction} url=${profile.start.url} />`}</div>`)}</div>`
    : null;
  if (inp.view === 'cards')
    return [
      head,
      configured,
      list.length ? html`<div class="cards">${list.map((t) => card(t, grants))}</div>` : html`<div class="empty">no traps soaking</div>`,
    ];
  return [
    head,
    configured,
    Table(
      [
        'address',
        inp.configured?.length ? 'repo or profile' : 'repo',
        inp.configured?.length ? 'folder' : 'worktree',
        'harness',
        'session',
        'now',
        'listening',
        'heartbeat',
        'mail',
        'catches',
        'window',
      ],
      list.map((t) => row(t, grants)),
      'no traps soaking',
    ),
  ];
}
