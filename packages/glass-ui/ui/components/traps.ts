import { HarnessIcon } from './harness-icon.js';
import { validDesktopStartLink } from '../../../core/src/desktop-start-link.js';
import type { Grant } from '@lobstah/core';
import { GrantChip } from './session-grants.js';
import type { GlassTrapView as GlassTrap } from '../../src/glass-diff.js';
import type { SectionInputs } from '../../src/glass-diff.js';
import { catchCount } from '../../src/glass-diff.js';
import { html, type Children } from '../html.js';
import { setPrefs } from '../actions.js';
import { Button } from './button.js';
import type { TrapGrouping } from '../../src/glass-diff.js';
import { Card, OpenIcon } from './card.js';
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
 * harness and state chip; its repo and catches; what it is doing now; and
 * the boat it runs on, with the Open icon at the right of that line. The session, worktree, heartbeat, mail
 * and grants are in the trap's modal.
 */
export function trapCard(t: GlassTrap) {
  const status = trapStatus(t);
  const boat = trapBoat(t);
  const scope = trapScope(t) || (t.live ? 'addressed bait only' : '');
  // Open, as its icon, at the right of the boat's line: the card has no bar of its own.
  const open = trapOpen(t, OpenIcon);
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
    foot=${(boat || open) && { left: boat && ['⛵ ', boat], right: open }}
    extra=${startCommands(t)}
    quiet=${!t.live && !t.starting}
    onClick=${opener('trap', t.trapId)}
  />`;
}

/** A failed start or a departed registration belongs in the collapsed history, never the live list. */
function inactiveTrap(trap: GlassTrap): boolean {
  return !!trap.starting?.failedAt || (!trap.live && !trap.starting && !trap.requested);
}

/** Keep the existing card or table intact inside each selected group. */
function groupedTraps(traps: GlassTrap[], grouping: TrapGrouping, view: SectionInputs['traps']['view'], grants: Grant[]): Children {
  const groups = new Map<string, GlassTrap[]>();
  for (const trap of traps) {
    const key =
      grouping === 'repo'
        ? trap.repo || (trap.configured ? 'Configured traps' : 'No repo')
        : grouping === 'harness'
          ? trap.harness || ''
          : trapStatus(trap).word;
    const members = groups.get(key) ?? [];
    members.push(trap);
    groups.set(key, members);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, members]) => html`<section class="trap-group" key=${key} data-group=${key}>
    <h3>${grouping === 'harness' ? html`<${HarnessIcon} harness=${key} />` : grouping === 'status' ? key.charAt(0).toUpperCase() + key.slice(1) : key} <span class="dim">(${members.length})</span></h3>
    ${
      view === 'cards'
        ? html`<div class="cards">${members.map((trap) => trapCard(trap))}</div>`
        : Table(
            [
              'address',
              members.some((trap) => trap.configured) ? 'repo or profile' : 'repo',
              members.some((trap) => trap.configured) ? 'folder' : 'worktree',
              'harness',
              'session',
              'now',
              'listening',
              'heartbeat',
              'mail',
              'catches',
              'window',
            ],
            members.map((trap) => row(trap, grants)),
            'No traps',
          )
    }
  </section>`,
    );
}

/** The Traps page owns grouping and history; the deck keeps its existing trap preview. */
export function Traps({ inp, grants = [] }: { inp: SectionInputs['traps']; grants?: Grant[] }): Children {
  const list = inp.list.map((seat) => seat.x);
  const active = list.filter((trap) => !inactiveTrap(trap));
  const inactive = list.filter(inactiveTrap);
  const grouping = inp.groupBy ?? 'repo';
  const head = html`<div class="tabhead trap-controls"><div class="seg" role="group" aria-label="Group traps by">${(['repo', 'harness', 'status'] as const).map((choice) => html`<${Button} key=${choice} pressed=${grouping === choice} onClick=${() => setPrefs({ trapGroup: choice })}>${choice.charAt(0).toUpperCase() + choice.slice(1)}<//>`)}</div><${NewTrap} /></div>`;
  const overview = inp.overview?.length
    ? html`<div class="trap-overview" aria-label="Fleet overview">${inp.overview.map((repo) => html`<div key=${repo.repo} class="trap-overview-row"><b>${repo.repo}</b><span>${repo.used}${repo.limit === undefined ? '' : '/' + repo.limit} in use · ${repo.free} free</span>${repo.harnesses.map(({ harness, count }) => html`<span class="trap-harness-count"><${HarnessIcon} harness=${harness} /> ${count}</span>`)}</div>`)}</div>`
    : null;
  const configured = inp.configured?.length
    ? html`<div class="cards configured-traps">${inp.configured.map((profile) => html`<div class="card"><div class="top"><b>trap:${profile.profile}</b><span class="badge">${profile.state}</span></div><div class="meta">${profile.grounds} · <${HarnessIcon} harness=${profile.harness} /> · ${profile.surface} · ${profile.capacity}</div>${profile.cwd && html`<div class="note">${profile.cwd}</div>`}${profile.pending?.length && html`<div class="note">Queued: ${profile.pending.join(', ')}</div>`}${profile.start && validDesktopStartLink(profile.start.url) && html`<${DesktopStartAction} url=${profile.start.url} />`}</div>`)}</div>`
    : null;
  return [
    head,
    overview,
    configured,
    active.length ? groupedTraps(active, grouping, inp.view, grants) : html`<div class="empty">No traps soaking</div>`,
    inactive.length > 0 &&
      html`<details class="trap-inactive"><summary>Stowed and ghosted (${inactive.length})</summary>${groupedTraps(inactive, grouping, inp.view, grants)}</details>`,
  ];
}
