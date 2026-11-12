import type { GlassSettings, SettingRow } from '@lobstah/core';
import { html } from '../html.js';
import { can, capabilities } from '../backend.js';
import { passkeysWorkHere, registerRunPasskey, runPasskeyUrl } from '../actions.js';
import type { GlassState } from '../store.js';
import { Button } from './button.js';

/**
 * A repo's traps in use beside its cap, `3 of 5 traps in use`, then the stowed
 * and ghosted ones the cap doesn't count, and any ghosted trap whose session
 * is still open. A count past its cap says so.
 */
export function trapCountText(traps: { used: number; limit?: number; idle?: number; held?: string[] }): string {
  const used =
    traps.limit === undefined
      ? `${traps.used} ${traps.used === 1 ? 'trap' : 'traps'} in use, no cap`
      : `${traps.used} of ${traps.limit} traps in use${traps.used > traps.limit ? ', over the cap' : ''}`;
  const idle = traps.idle ? ` · +${traps.idle} stowed or ghosted` : '';
  const held = traps.held?.length
    ? ` · ${traps.held.join(', ')} still ${traps.held.length === 1 ? 'has its session' : 'have their sessions'} open`
    : '';
  return used + idle + held;
}

const rowsOf = (rows: SettingRow[]) =>
  html`<div class="cfgrows">${rows.map(
    (row) =>
      html`<div key=${row.key} class="cfgrow"><span class="cfgkey">${row.key}</span><span class="cfgvalue">${row.value}</span><span class=${'cfgsource' + (row.source === 'config' ? ' set' : '')}>${row.source === 'config' ? 'Set' : 'Default'}</span></div>`,
  )}</div>`;

/**
 * Run cards' passkey: how many are registered, and Register. A passkey is
 * made for `localhost`, so the 127.0.0.1 page links there instead.
 */
export function RunPasskeySettings({
  passkeys,
  passkey,
}: {
  passkeys?: { count: number; newestAt?: string; hosted?: number };
  passkey?: GlassState['runPasskey'];
}) {
  if (!can('run')) return null;
  // The hosted glass (a mirror boat's, with no daemon of its own): a phone pairs its passkey from the Mac.
  if (!capabilities().daemon) {
    const phones = passkeys?.hosted ?? 0;
    return html`<section class="runpasskeys"><h2>Run cards</h2>
      <div class=${phones ? 'ok' : 'dim'}>${phones ? `${phones} phone passkey${phones === 1 ? '' : 's'} paired. Run asks for one, then covers 15 minutes on that page.` : 'No phone passkey yet.'}</div>
      <div class="dim">To pair this phone, run <code>lobstah run passkey add --hosted</code> on the Mac.</div>
    </section>`;
  }
  const count = passkeys?.count ?? 0;
  return html`<section class="runpasskeys"><h2>Run cards</h2>
    <div class=${count ? 'ok' : 'dim'}>${count ? `${count} passkey${count === 1 ? '' : 's'} registered${passkeys?.newestAt ? `, newest ${new Date(passkeys.newestAt).toLocaleString()}` : ''}. Run asks for one each time; another needs one of these and the macOS password.` : 'No passkey yet: register one to run cards. Registering asks for the macOS password; Run asks for the passkey (Touch ID) each time.'}</div>
    ${
      passkeysWorkHere()
        ? html`<div class="runfoot"><${Button} class="runregister" disabled=${!!passkey?.busy} onClick=${() => void registerRunPasskey()}>${passkey?.busy ? 'Registering…' : count ? 'Register another passkey' : 'Register a passkey'}<//></div>`
        : html`<div class="dim">Passkeys work from <a href=${runPasskeyUrl('#settings')}>${runPasskeyUrl().replace(/\/$/, '')}</a>: register one there.</div>`
    }
    ${passkey?.done && html`<div class="ok">${passkey.done}</div>`}
    ${passkey?.error && html`<div class="bad">${passkey.error}</div>`}
  </section>`;
}

/** The Settings tab: the run passkeys, then the effective configuration, read-only and already masked by the server. */
export function Settings({
  page,
  error,
  passkeys,
  passkey,
}: {
  page: GlassSettings | null;
  error: string | null;
  passkeys?: { count: number; newestAt?: string };
  passkey?: GlassState['runPasskey'];
}) {
  const runs = html`<${RunPasskeySettings} passkeys=${passkeys} passkey=${passkey} />`;
  if (!page) return [runs, html`<div class=${error ? 'bad' : 'dim'}>${error ?? 'Loading settings'}</div>`];
  return html`${runs}<div class="cfg">
    <p class="dim">Read-only. Values marked Set come from <code>${page.file}</code>. Secrets are masked.</p>
    ${error && html`<div class="bad">${error}</div>`}
    ${page.error && html`<div class="bad">${page.error}</div>`}
    <h2>Versions</h2>
    <div class=${page.versions.match ? 'ok' : 'warn'}>${page.versions.text}</div>
    <div class="cfgrows">${page.versions.rows.map(
      (row) =>
        html`<div key=${row.name} class="cfgrow"><span class="cfgkey">${row.name}</span><span class="cfgvalue">${row.version}</span><span class="cfgsource">${row.note ?? ''}</span></div>`,
    )}</div>
    ${
      page.grounds.length > 0 && [
        html`<h2>Grounds</h2>`,
        html`<div class="cfgrows">${page.grounds.map(
          (grounds) =>
            html`<div key=${grounds.name} class="cfgrow"><span class="cfgkey">${grounds.name}</span><span class="cfgvalue">${grounds.repos.join(', ') || '(no repos)'}</span><span class="cfgsource"></span></div>`,
        )}</div>`,
      ]
    }
    ${page.repos.length > 0 && html`<h2>Repos</h2>`}
    ${page.repos.map(
      (repo) =>
        html`<section key=${repo.key} class="cfgrepo"><h3>${repo.key} <span class=${'cfgtraps' + (repo.traps.limit !== undefined && repo.traps.used > repo.traps.limit ? ' warn' : ' dim')}>${trapCountText(repo.traps)}</span></h3>${rowsOf(repo.rows)}</section>`,
    )}
    ${page.sections.map((section) => html`<section key=${section.title}><h2>${section.title}</h2>${rowsOf(section.rows)}</section>`)}
  </div>`;
}
