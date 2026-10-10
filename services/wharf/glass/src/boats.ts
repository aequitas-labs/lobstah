import { useState } from 'preact/hooks';
import { html, value, when } from './common.js';
import type { Action } from './common.js';
import type { Boat } from './model.js';
export function Boats({ boats, action, deleteAccount }: { boats: Boat[]; action: Action; deleteAccount: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState(''),
    [repo, setRepo] = useState('');
  return html`<div class="sub">Enroll or change a boat's name/access with <code>lobstah wharf login</code> on that boat, then approve here. No browser edit or grants.</div><div class="cards">${boats.map(
    (b) =>
      html`<div class="card"><div class="top"><b>${b.name}</b><span class="badge">${b.revoked ? 'revoked' : b.permissions.join(' + ')}</span></div><div class="meta">last check-in ${when(b.lastCheckIn)}</div><div class="note">${b.repos.join(' · ') || 'no repos checked in'}</div>${
        !b.revoked &&
        html`<div class="foot">${
          confirmation === b.id
            ? html`<button class="btn" onClick=${async () => {
                if (await action(`boats/${b.id}/revoke`, {})) setConfirmation('');
              }}>confirm revoke ${b.name}</button><button class="btn" onClick=${() => setConfirmation('')}>keep boat</button>`
            : html`<button class="btn" onClick=${() => setConfirmation(b.id)}>revoke…</button>`
        }<button class="btn" onClick=${() => {
          setConfirmation('request:' + b.id);
          setRepo(b.repos[0] ?? '');
        }}>request trap…</button></div>`
      }${
        confirmation === 'request:' + b.id &&
        html`<form onSubmit=${async (e: Event) => {
          e.preventDefault();
          if (await action('requests', { id: crypto.randomUUID(), kind: 'trap-request', boat: b.id, repo })) setConfirmation('');
        }}><label>repo remote <input aria-label="trap request repo" value=${repo} maxLength="256" onInput=${(e: Event) => setRepo(value(e))} /></label><button class="btn" disabled=${!repo}>queue trap request</button><div class="dim">Waits for helm; only opted-in boats can fulfill it. Expires in 10 minutes.</div></form>`
      }</div>`,
  )}</div>
    <div class="sec">account</div>${confirmation === 'account' ? html`<div class="bad">Delete this account's jobs, messages, files, boats and sign-in data? This cannot be undone.<button class="btn" onClick=${deleteAccount}>confirm delete account</button><button class="btn" onClick=${() => setConfirmation('')}>keep account</button></div>` : html`<button class="btn" onClick=${() => setConfirmation('account')}>delete account…</button>`}`;
}
