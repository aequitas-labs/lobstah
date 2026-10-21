import { useState } from 'preact/hooks';
import type { Grant } from '@lobstah/core';
import { html } from '../html.js';
import { reviewRequest } from '../actions.js';

export function SessionGrants({ grants }: { grants: Grant[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const revoke = (id: string) => async () => {
    setBusy(id);
    setError(await reviewRequest('grant-revoke', { id }));
    setBusy(null);
  };
  if (!grants.length) return null;
  return html`<section class="session-grants"><h2>Active session grants</h2><div class="cards">${grants.map((g) => html`<div class="card" key=${g.id}><div class="top"><b>${g.tools}</b><span class="badge warn">${g.uses} uses</span></div><div class="rv-reason">Session ${g.session}</div>${g.command && html`<code>${g.command} …</code>`}<div class="rv-reason">Hosts: ${g.hosts?.join(', ') || 'not pinned'}</div><div class="rv-reason">Expires ${g.expiresAt ? new Date(g.expiresAt).toLocaleTimeString() : 'unknown'}</div>${g.reason && html`<div class="rv-reason">${g.reason}</div>`}<details><summary>Use log (${g.audit?.length ?? 0} recent)</summary>${g.audit?.map((a) => html`<div class="rv-reason">${new Date(a.at).toLocaleTimeString()} · ${a.tool}${a.hosts?.length ? ` · ${a.hosts.join(', ')}` : ''}</div>`)}</details><div class="foot"><button class="btn" disabled=${busy === g.id} onClick=${revoke(g.id)}>Revoke</button></div></div>`)}</div>${error && html`<div class="bad" role="alert">${error}</div>`}</section>`;
}
