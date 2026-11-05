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

/** How long a grant has left, in words. */
export function grantExpiryText(expiresAt: string | undefined, now = Date.now()): string {
  if (!expiresAt) return 'Until revoked';
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60_000);
  if (minutes <= 0) return 'Expired';
  return minutes < 120 ? `Expires in ${minutes} min` : `Expires in ${Math.round(minutes / 60)} h`;
}

/** Who a grant covers, in words. */
function grantScopeText(grant: Grant): string {
  if (grant.trap) return `Trap ${grant.trap}`;
  if (grant.mode === 'intent') return `Every trap in ${grant.repo}`;
  return 'Every trap';
}

/** What a grant covers, as its card leads with it. */
function grantLead(grant: Grant): string {
  if (grant.intent) return grant.intent.text;
  if (grant.tools) return grant.tools;
  if (grant.path !== undefined) return `Write ${grant.path}`;
  return grant.match === 'prefix' ? `${grant.command} …` : (grant.command ?? '');
}

/** One grant that isn't tied to a session: what it covers, who it's for, how it's been used, and a way to take it back. */
function StandingGrant({ grant, busy, revoke }: { grant: Grant; busy: boolean; revoke: () => void }) {
  const patterns = grant.intent?.patterns ?? [];
  return html`<div class="card standing-grant" key=${grant.id}>
    <div class="top"><b class="grant-lead">${grantLead(grant)}</b><span class="badge warn">${grant.uses} ${grant.uses === 1 ? 'use' : 'uses'}</span></div>
    <div class="grant-scope">${grantScopeText(grant)}${grant.harness === 'any' ? '' : ` · ${grant.harness === 'codex' ? 'Codex' : 'Claude Code'}`}</div>
    ${patterns.length > 0 && html`<ul class="grant-patterns">${patterns.map((item) => html`<li key=${item.kind + item.pattern}><code>${intentPatternLabel(item)}</code></li>`)}</ul>`}
    <div>${grantExpiryText(grant.expiresAt)}${grant.lastUsedAt && [' · last used ', html`<time datetime=${grant.lastUsedAt}>${new Date(grant.lastUsedAt).toLocaleString()}</time>`]}</div>
    <div class="dim grant-id">${grant.id}</div>
    <div class="foot"><button class="btn" disabled=${busy} onClick=${revoke}>Revoke</button></div>
  </div>`;
}

const intentPatternLabel = (item: { kind: string; pattern: string }): string =>
  item.kind === 'command' ? item.pattern : `${item.kind}:${item.pattern}`;

export function SessionGrants({ grants, standing = [] }: { grants: Grant[]; standing?: Grant[] }) {
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
  return html`<section class="session-grants"><h2>Grants</h2>${!active.length && !standing.length && html`<div class="empty">No active grants</div>`}${standing.length > 0 && html`<div class="cards standing-grants">${standing.map((grant) => html`<${StandingGrant} key=${grant.id} grant=${grant} busy=${busy === grant.id} revoke=${revoke(grant.id)} />`)}</div>`}<div class="cards">${active.map((g) => html`<div class="card" key=${g.id}><div class="top"><b>${g.tools}</b><span class="badge warn">${g.uses} ${g.uses === 1 ? 'use' : 'uses'}</span></div><div class="grant-scope">Session ${g.session}</div>${g.command && html`<code class="grant-scope">${g.command} …</code>`}${g.hosts?.length && html`<div class="grant-scope">Hosts ${g.hosts.join(', ')}</div>`}<div>Expires <time datetime=${g.expiresAt}>${new Date(g.expiresAt!).toLocaleTimeString()}</time></div><div class="foot"><button class="btn" disabled=${busy === g.id} onClick=${revoke(g.id)}>Revoke</button></div></div>`)}</div>${error && html`<div class="bad" role="alert">${error}</div>`}${audit.length > 0 && html`<h2>Use log</h2><ul class="grant-audit">${audit.map((a, i) => html`<li key=${a.id + ':' + i}><time datetime=${a.at}>${new Date(a.at).toLocaleTimeString()}</time><code>${a.tool}</code>${a.hosts?.length ? html`<span>${a.hosts.join(', ')}</span>` : null}<span class="dim">Session ${a.session}</span></li>`)}</ul>`}</section>`;
}
