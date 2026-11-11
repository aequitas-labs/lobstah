import { useState } from 'preact/hooks';
import { html, value, when } from './common.js';
import type { Action } from './common.js';
import type { Boat } from './model.js';
import { accessLabel } from './device.js';
import { LinkedText } from '../../../../packages/glass-ui/ui/components/links.js';
import { SlackLinkSection } from './slack.js';
import { Age } from '../../../../packages/glass-ui/ui/components/common.js';
import { ExpandingCard } from '../../../../packages/glass-ui/ui/components/card.js';
import type { CardState } from '../../../../packages/glass-ui/ui/components/card.js';
import { MIRROR_STALE_MS } from '../../../../packages/glass-ui/ui/mirror-merge.js';
import type { MirrorBoatView } from '../../../../packages/glass-ui/ui/mirror-merge.js';

/** online, asleep or revoked, from its mirror snapshot's age where it mirrors, else its last check-in. */
function boatState(b: Boat, mirror: MirrorBoatView | undefined, now = Date.now()): CardState {
  if (b.revoked) return { word: 'revoked', tone: 'dim', mark: 'chip' };
  const asleep = mirror ? mirror.stale : !b.lastCheckIn || now - Date.parse(b.lastCheckIn) > MIRROR_STALE_MS;
  return asleep ? { word: 'asleep', tone: 'dim', mark: 'chip' } : { word: 'online', tone: 'ok', mark: 'chip' };
}

/**
 * The Boats tab: one card per boat. Its name and state chip, then its access
 * and how old its mirror (or last check-in) is, with revoke. A tap shows its
 * repos and the trap request.
 */
export function Boats({
  boats,
  mirrors = [],
  action,
  deleteAccount,
}: {
  boats: Boat[];
  mirrors?: MirrorBoatView[];
  action: Action;
  deleteAccount: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState(''),
    [repo, setRepo] = useState('');
  const stop = (f: () => unknown) => (e: Event) => {
    e.stopPropagation();
    void f();
  };
  const card = (b: Boat) => {
    const mirror = mirrors.find((m) => m.boat === b.id);
    const access = b.revoked ? 'no access' : accessLabel(b.permissions);
    const age = mirror
      ? ['mirrored ', Age(mirror.at), ' ago']
      : b.lastCheckIn
        ? ['checked in ', Age(b.lastCheckIn), ' ago']
        : ['never checked in'];
    const revoke =
      !b.revoked &&
      (confirmation === b.id
        ? html`<button class="btn" onClick=${stop(async () => {
            if (await action(`boats/${b.id}/revoke`, {})) setConfirmation('');
          })}>revoke ${b.name}</button><button class="btn" onClick=${stop(() => setConfirmation(''))}>keep ${b.name}</button>`
        : html`<button class="btn" onClick=${stop(() => setConfirmation(b.id))}>revoke…</button>`);
    return html`<${ExpandingCard}
      key=${b.id}
      cls="boat-card"
      title=${b.name}
      titleAttr=${b.name}
      state=${boatState(b, mirror)}
      context=${[access, ' · ', ...age]}
      contextTitle=${`${access} · last check-in ${when(b.lastCheckIn)}`}
      action=${revoke}
      quiet=${!!b.revoked}
      more=${[
        html`<div>${b.repos.join('') ? LinkedText(b.repos.join(' · ')) : 'no repos checked in'}</div>`,
        html`<div class="dim">last check-in ${when(b.lastCheckIn)}</div>`,
        !b.revoked &&
          html`<div><button class="btn" onClick=${() => {
            setConfirmation('request:' + b.id);
            setRepo(b.repos[0] ?? '');
          }}>request trap…</button></div>`,
        confirmation === 'request:' + b.id &&
          html`<form onSubmit=${async (e: Event) => {
            e.preventDefault();
            if (await action('requests', { id: crypto.randomUUID(), kind: 'trap-request', boat: b.id, repo })) setConfirmation('');
          }}><label>repo remote <input aria-label="trap request repo" value=${repo} maxLength="256" onInput=${(e: Event) => setRepo(value(e))} /></label><button class="btn" disabled=${!repo}>queue trap request</button><div class="dim">Waits for helm; only opted-in boats can fulfill it. Expires in 10 minutes.</div></form>`,
      ]}
    />`;
  };
  return html`<div class="sub">Enroll or change a boat's name/access with <code>lobstah wharf login</code> on that boat, then approve here. No browser edit or grants.</div><div class="cards">${boats.map(card)}</div>
    <${SlackLinkSection} />
    <div class="sec">account</div>${confirmation === 'account' ? html`<div class="bad">Delete this account's dispatches, messages, files, boats and sign-in data? This cannot be undone.<button class="btn" onClick=${deleteAccount}>confirm delete account</button><button class="btn" onClick=${() => setConfirmation('')}>keep account</button></div>` : html`<button class="btn" onClick=${() => setConfirmation('account')}>delete account…</button>`}`;
}
