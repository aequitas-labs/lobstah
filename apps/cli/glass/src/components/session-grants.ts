import { useState } from 'preact/hooks';
import type { Grant } from '@lobstah/core';
import { html } from '../html.js';
import { reviewRequest } from '../actions.js';

export function activeSessionGrants(grants: Grant[], now = Date.now()): Grant[] {
  return grants.filter((g) => g.mode === 'session' && !g.revokedAt && !!g.expiresAt && Date.parse(g.expiresAt) > now);
}

export function GrantChip({ session, grants = [] }: { session?: string; grants?: Grant[] }) {
  const now = Date.now();
  const covered = activeSessionGrants(grants, now).filter((g) => g.session === session);
  if (!session || !covered.length) return null;
  const remaining = Math.ceil((Math.max(...covered.map((g) => Date.parse(g.expiresAt!))) - now) / 60_000);
  return html`<a class="badge grant-chip" href="#grants" onClick=${(e: Event) => e.stopPropagation()}>grant · ${remaining}m left</a>`;
}

export function SessionGrants({ grants }: { grants: Grant[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const revoke = (id: string) => async () => {
    setBusy(id);
    setError(await reviewRequest('grant-revoke', { id }));
    setBusy(null);
  };
  const active = activeSessionGrants(grants);
  const audit = active
    .flatMap((g) =>
      (g.audit ?? [])
        .slice()
        .reverse()
        .map((a) => ({ ...a, session: g.session, id: g.id })),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  return html`<section class="session-grants"><h2>Grants</h2>${!active.length && html`<div class="empty">No active grants</div>`}<div class="cards">${active.map((g) => html`<div class="card" key=${g.id}><div class="top"><b>${g.tools}</b><span class="badge warn">${g.uses} ${g.uses === 1 ? 'use' : 'uses'}</span></div><div class="grant-scope">Session ${g.session}</div>${g.command && html`<code class="grant-scope">${g.command} …</code>`}${g.hosts?.length && html`<div class="grant-scope">Hosts ${g.hosts.join(', ')}</div>`}<div>Expires <time datetime=${g.expiresAt}>${new Date(g.expiresAt!).toLocaleTimeString()}</time></div><div class="foot"><button class="btn" disabled=${busy === g.id} onClick=${revoke(g.id)}>Revoke</button></div></div>`)}</div>${error && html`<div class="bad" role="alert">${error}</div>`}${audit.length > 0 && html`<h2>Use log</h2><ul class="grant-audit">${audit.map((a, i) => html`<li key=${a.id + ':' + i}><time datetime=${a.at}>${new Date(a.at).toLocaleTimeString()}</time><code>${a.tool}</code>${a.hosts?.length ? html`<span>${a.hosts.join(', ')}</span>` : null}<span class="dim">Session ${a.session}</span></li>`)}</ul>`}</section>`;
}
