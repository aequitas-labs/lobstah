import { HarnessIcon } from './harness-icon.js';
import { validDesktopStartLink } from '../../../core/src/desktop-start-link.js';
import type { Grant } from '@lobstah/core';
import { GrantChip } from './session-grants.js';
import type { GlassTrapView as GlassTrap } from '../../src/glass-diff.js';
import type { SectionInputs } from '../../src/glass-diff.js';
import { catchCount } from '../../src/glass-diff.js';
import { html } from '../html.js';
import { Card } from './card.js';
import {
  Harness,
  mailCell,
  NewTrap,
  opener,
  startCommands,
  Table,
  trapBoat,
  trapNow,
  trapDisplayName,
  trapOpen,
  trapScope,
  trapRow,
  trapStatus,
  trapWork,
  trapWorkText,
  windowAction,
  DesktopStartAction,
  RepoName,
} from './common.js';

/** The Traps tab: live seats, reserved (starting) ones, and the history of signed-off ones. */

const dim = (t: GlassTrap): string => (t.live || t.starting ? '' : ' dim');

function row(t: GlassTrap, grants: Grant[]) {
  const r = trapRow(t);
  return html`<tr key=${t.trapId} class=${'rowhead' + dim(t)} onClick=${opener('trap', t.trapId)}><td><b title=${`wt:${t.trapId}`}>${trapDisplayName(t)}</b><div class="trap-address dim">wt:${t.trapId}</div></td><td>${t.configured ? `trap:${t.configured.profile} · ${t.configured.grounds}` : (t.repo ?? '—')}</td><td class="grow">${t.worktree ?? ''}</td><td>${t.harness && html`<${Harness} worker=${t} cls="" compact />`}</td><td>${(t.sessionId ?? '').slice(0, 8)}<${GrantChip} session=${t.sessionId} grants=${grants} /></td><td>${trapNow(t)}${startCommands(t)}</td><td>${r.listen}</td><td>${r.hb}</td><td>${mailCell(t)}</td><td class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</td><td>${windowAction(t)}</td></tr>`;
}

/**
 * A trap as a card, the same on every glass and at every width: its name,
 * harness and state chip; its repo and catches; what it is doing now; the
 * boat it runs on; and a bottom bar with ↗ Open at its right. The session, worktree, heartbeat, mail
 * and grants are in the trap's modal.
 */
export function trapCard(t: GlassTrap) {
  const status = trapStatus(t);
  const boat = trapBoat(t);
  const scope = trapScope(t) || (t.live ? 'addressed bait only' : '');
  return html`<${Card}
    key=${t.trapId}
    title=${trapDisplayName(t)}
    titleAttr=${`wt:${t.trapId}`}
    icon=${t.harness && html`<${Harness} worker=${t} cls="" compact />`}
    state=${{ word: status.word, tone: status.tone, mark: 'chip' }}
    context=${[
      t.repo && !t.configured ? RepoName(t.repo) : scope,
      html`<span class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</span>`,
    ]
      .filter(Boolean)
      .flatMap((part, i) => (i ? [' · ', part] : [part]))}
    contextTitle=${scope}
    now=${trapWork(t)}
    nowTitle=${trapWorkText(t)}
    foot=${boat && { left: ['⛵ ', boat] }}
    extra=${startCommands(t)}
    actions=${trapOpen(t)}
    quiet=${!t.live && !t.starting}
    onClick=${opener('trap', t.trapId)}
  />`;
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
      list.length ? html`<div class="cards">${list.map((t) => trapCard(t))}</div>` : html`<div class="empty">no traps soaking</div>`,
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
