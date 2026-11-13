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
import { BOAT_STATE_ICON } from '../../../../packages/glass-ui/ui/components/icons.js';
import { Button } from '../../../../packages/glass-ui/ui/components/button.js';
import { SectionHead } from '../../../../packages/glass-ui/ui/components/section-head.js';
import { NewTrap } from '../../../../packages/glass-ui/ui/components/common.js';

/** online, asleep or revoked, from its mirror snapshot's age where it mirrors, else its last check-in. */
function boatState(b: Boat, mirror: MirrorBoatView | undefined, now = Date.now()): CardState {
  const asleep = mirror ? mirror.stale : !b.lastCheckIn || now - Date.parse(b.lastCheckIn) > MIRROR_STALE_MS;
  const word = b.revoked ? 'revoked' : asleep ? 'asleep' : 'online';
  const tone = word === 'online' ? 'ok' : 'dim';
  return {
    word,
    tone,
    mark: 'chip',
    icon: html`<span class=${'gchip ' + tone}><span class="boat-state-icon" aria-hidden="true">${BOAT_STATE_ICON[word]}</span>${word}</span>`,
  };
}

/**
 * The Boats tab: one card per boat. Its name and state chip, then its access
 * and how old its mirror (or last check-in) is, then revoke and request trap
 * on a line of their own. A tap shows its repos and last check-in above
 * them, and the trap request.
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
}): ReturnType<typeof html> {
  const [confirmation, setConfirmation] = useState(''),
    [repo, setRepo] = useState('');
  const stop = (f: () => unknown) => (e: Event) => {
    e.stopPropagation();
    void f();
  };
  const card = (b: Boat) => {
    const mirror = mirrors.find((m) => m.boat === b.id);
    const access = b.revoked ? 'no access' : accessLabel(b.permissions);
    const age = mirror ? [Age(mirror.at), ' ago'] : b.lastCheckIn ? [Age(b.lastCheckIn), ' ago'] : ['Never'];
    const revoke =
      !b.revoked &&
      (confirmation === b.id
        ? html`<${Button} variant="danger" onClick=${stop(async () => {
            if (await action(`boats/${b.id}/revoke`, {})) setConfirmation('');
          })}>revoke ${b.name}<//><${Button} onClick=${stop(() => setConfirmation(''))}>keep ${b.name}<//>`
        : html`<${Button} onClick=${stop(() => setConfirmation(b.id))}>revoke…<//>`);
    return html`<${ExpandingCard}
      key=${b.id}
      cls="boat-card"
      title=${b.name}
      titleAttr=${b.name}
      state=${boatState(b, mirror)}
      context=${html`<dl class="boat-details"><dt>Permissions</dt><dd class="boat-permissions">${access}</dd><dt>${mirror ? 'Last mirror' : 'Last check-in'}</dt><dd>${age}</dd></dl>`}
      contextTitle=${`${access} · last check-in ${when(b.lastCheckIn)}`}
      actions=${revoke}
      quiet=${!!b.revoked}
      more=${[
        html`<div>${b.repos.join('') ? LinkedText(b.repos.join(' · ')) : 'no repos checked in'}</div>`,
        html`<div class="dim">last check-in ${when(b.lastCheckIn)}</div>`,
        !b.revoked &&
          html`<div><${Button} onClick=${() => {
            setConfirmation('request:' + b.id);
            setRepo(b.repos[0] ?? '');
          }}>request trap…<//></div>`,
        confirmation === 'request:' + b.id &&
          html`<form onSubmit=${async (e: Event) => {
            e.preventDefault();
            if (await action('requests', { id: crypto.randomUUID(), kind: 'trap-request', boat: b.id, repo })) setConfirmation('');
          }}><label>repo remote <input aria-label="trap request repo" value=${repo} maxLength="256" onInput=${(e: Event) => setRepo(value(e))} /></label><${Button} type="submit" disabled=${!repo}>queue trap request<//><div class="dim">Waits for helm; only opted-in boats can fulfill it. Expires in 10 minutes.</div></form>`,
      ]}
    />`;
  };
  return html`<section class="boats-section" aria-labelledby="boats-heading"><${SectionHead} title="Boats" page id="boats-heading" action=${html`<${NewTrap} />`} /><p class="dim">Connect a boat with <code>lobstah wharf login</code>, then approve it here</p><div class="cards boats-grid">${boats.map(card)}</div></section>
    <section class="boat-settings" aria-labelledby="slack-heading"><${SlackLinkSection} /></section>
    <section class="boat-settings" aria-labelledby="account-heading"><h2 id="account-heading">Account</h2>${confirmation === 'account' ? html`<div class="bad">Delete this account's dispatches, messages, files, boats and sign-in data? This cannot be undone.<${Button} variant="danger" onClick=${deleteAccount}>confirm delete account<//><${Button} onClick=${() => setConfirmation('')}>keep account<//></div>` : html`<${Button} onClick=${() => setConfirmation('account')}>delete account…<//>`}</section>`;
}
