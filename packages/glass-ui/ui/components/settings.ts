import type { GlassSettings, SettingRow } from '@lobstah/core';
import { html } from '../html.js';

/** A repo's trap count beside its cap, `3 of 5 traps`; a count past its cap says so. */
export function trapCountText(traps: { used: number; limit?: number }): string {
  if (traps.limit === undefined) return `${traps.used} ${traps.used === 1 ? 'trap' : 'traps'}, no cap`;
  return `${traps.used} of ${traps.limit} traps${traps.used > traps.limit ? ', over the cap' : ''}`;
}

const rowsOf = (rows: SettingRow[]) =>
  html`<div class="cfgrows">${rows.map(
    (row) =>
      html`<div key=${row.key} class="cfgrow"><span class="cfgkey">${row.key}</span><span class="cfgvalue">${row.value}</span><span class=${'cfgsource' + (row.source === 'config' ? ' set' : '')}>${row.source === 'config' ? 'Set' : 'Default'}</span></div>`,
  )}</div>`;

/** The Settings tab: the effective configuration, read-only and already masked by the server. */
export function Settings({ page, error }: { page: GlassSettings | null; error: string | null }) {
  if (!page) return html`<div class=${error ? 'bad' : 'dim'}>${error ?? 'Loading settings'}</div>`;
  return html`<div class="cfg">
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
