import { useState } from 'preact/hooks';
import type { Grant } from '@lobstah/core';
import { html } from '../html.js';
import { closeModal, reviewRequest } from '../actions.js';
import { ExpandingCard } from './card.js';
import { REPO_MARK, TRAP_MARK } from './common.js';

export function activeSessionGrants(grants: Grant[], now = Date.now()): Grant[] {
  return grants.filter((g) => g.mode === 'session' && !g.revokedAt && !!g.expiresAt && Date.parse(g.expiresAt) > now);
}

export function GrantChip({ session, grants = [] }: { session?: string; grants?: Grant[] }) {
  const now = Date.now();
  const covered = activeSessionGrants(grants, now).filter((g) => g.session === session);
  if (!session || !covered.length) return null;
  const remaining = Math.ceil((Math.max(...covered.map((g) => Date.parse(g.expiresAt!))) - now) / 60_000);
  // From a trap's modal, the chip leads to Grants and closes the modal on its way.
  const follow = (e: Event) => {
    e.stopPropagation();
    closeModal();
  };
  return html`<a class="badge grant-chip" href="#grants" onClick=${follow}>grant · ${remaining}m left</a>`;
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
  if (grant.trap) return `${TRAP_MARK} ${grant.trap}`;
  if (grant.mode === 'intent') return `Every trap in ${REPO_MARK} ${grant.repo}`;
  return 'Every trap';
}

/** What a grant covers, as its card leads with it. */
function grantLead(grant: Grant): string {
  if (grant.intent) return grant.intent.text;
  if (grant.tools) return grant.tools;
  if (grant.path !== undefined) return `Write ${grant.path}`;
  return grant.match === 'prefix' ? `${grant.command} …` : (grant.command ?? '');
}

/** A sentence's text with its first letter lowercased, to sit mid-line: "Expires in 9 min" as "expires in 9 min". */
const midLine = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Revoke, at the right of a grant card's line 2: it never expands the card. */
const revokeButton = (busy: boolean, revoke: () => void) =>
  html`<button class="btn" disabled=${busy} onClick=${(e: Event) => {
    e.stopPropagation();
    revoke();
  }}>Revoke</button>`;

const usesText = (uses: number) => `${uses} ${uses === 1 ? 'use' : 'uses'}`;

/**
 * One grant that isn't tied to a session: what it allows and `active` on a
 * green edge, then who it covers and how long it has left, with Revoke. A tap
 * shows its uses, harness, patterns, last use and id.
 */
function StandingGrant({ grant, busy, revoke }: { grant: Grant; busy: boolean; revoke: () => void }) {
  const patterns = grant.intent?.patterns ?? [];
  const context = `${grantScopeText(grant)} · ${midLine(grantExpiryText(grant.expiresAt))}`;
  return html`<${ExpandingCard}
    key=${grant.id}
    cls="standing-grant"
    title=${grantLead(grant)}
    titleAttr=${grantLead(grant)}
    state=${{ word: 'active', tone: 'ok', mark: 'edge' }}
    context=${context}
    contextTitle=${context}
    action=${revokeButton(busy, revoke)}
    more=${[
      html`<div>${usesText(grant.uses)}${grant.harness === 'any' ? '' : ` · ${grant.harness === 'codex' ? 'Codex' : 'Claude Code'}`}${grant.lastUsedAt && [' · last used ', html`<time datetime=${grant.lastUsedAt}>${new Date(grant.lastUsedAt).toLocaleString()}</time>`]}</div>`,
      patterns.length > 0 &&
        html`<ul class="grant-patterns">${patterns.map((item) => html`<li key=${item.kind + item.pattern}><code>${intentPatternLabel(item)}</code></li>`)}</ul>`,
      html`<div class="dim grant-id">${grant.id}</div>`,
    ]}
  />`;
}

/** A session's grant: its tools and `active` on a green edge, then its session and time left, with Revoke. A tap shows its uses, command, hosts and id. */
function SessionGrant({ grant: g, busy, revoke }: { grant: Grant; busy: boolean; revoke: () => void }) {
  const context = `Session ${g.session} · ${midLine(grantExpiryText(g.expiresAt))}`;
  return html`<${ExpandingCard}
    key=${g.id}
    title=${g.tools}
    titleAttr=${g.tools}
    state=${{ word: 'active', tone: 'ok', mark: 'edge' }}
    context=${context}
    contextTitle=${context}
    action=${revokeButton(busy, revoke)}
    more=${[
      html`<div>${usesText(g.uses)} · expires <time datetime=${g.expiresAt}>${new Date(g.expiresAt!).toLocaleTimeString()}</time></div>`,
      g.command && html`<code class="grant-scope">${g.command} …</code>`,
      g.hosts?.length && html`<div class="grant-scope">Hosts ${g.hosts.join(', ')}</div>`,
      html`<div class="dim grant-id">${g.id}</div>`,
    ]}
  />`;
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
  return html`<section class="session-grants"><h2>Grants</h2>${!active.length && !standing.length && html`<div class="empty">No active grants</div>`}${standing.length > 0 && html`<div class="cards standing-grants">${standing.map((grant) => html`<${StandingGrant} key=${grant.id} grant=${grant} busy=${busy === grant.id} revoke=${revoke(grant.id)} />`)}</div>`}<div class="cards">${active.map((g) => html`<${SessionGrant} key=${g.id} grant=${g} busy=${busy === g.id} revoke=${revoke(g.id)} />`)}</div>${error && html`<div class="bad" role="alert">${error}</div>`}${audit.length > 0 && html`<h2>Use log</h2><ul class="grant-audit">${audit.map((a, i) => html`<li key=${a.id + ':' + i}><time datetime=${a.at}>${new Date(a.at).toLocaleTimeString()}</time><code>${a.tool}</code>${a.hosts?.length ? html`<span>${a.hosts.join(', ')}</span>` : null}<span class="dim">Session ${a.session}</span></li>`)}</ul>`}</section>`;
}
