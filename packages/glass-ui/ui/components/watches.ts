import type { WatchHealthState, WatchInventoryRow, WatchNextCheck } from '@lobstah/core';
import type { SectionInputs } from '../../src/glass-diff.js';
import { setPrefs } from '../actions.js';
import { html, type Children } from '../html.js';
import { Age, Table } from './common.js';
import { ExpandingCard } from './card.js';
import type { CardTone } from './card.js';
import { Button } from './button.js';
import { Glyph, SourceArt, SourceLogo } from './item-card.js';

/**
 * Watches, under Menu: every non-retired watch, with its source, owner,
 * last check attempt, next eligible check, health and latest error. The
 * schedule and health come from the boat's runtime projection; this page
 * only words them. It is read-only: Open is the one way out, and watch
 * lifecycle changes stay in the CLI.
 */

const HEALTH: Record<WatchHealthState, { word: string; tone: CardTone }> = {
  healthy: { word: 'healthy', tone: 'ok' },
  'not-checked': { word: 'not checked yet', tone: 'dim' },
  checking: { word: 'checking', tone: 'info' },
  retrying: { word: 'retrying', tone: 'warn' },
  held: { word: 'held', tone: 'bad' },
  stale: { word: 'stale', tone: 'warn' },
  offline: { word: 'offline', tone: 'bad' },
};

/** "in 33s", "in 4m": how long until a scheduled check, from this page's clock. */
function untilText(at: string): string {
  const s = Math.max(0, (Date.parse(at) - Date.now()) / 1000);
  if (s < 1) return 'due now';
  if (s < 90) return `in ${Math.round(s)}s`;
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${(s / 3600).toFixed(1)}h`;
}

/** The next check as the scheduler states it: an estimate, or why there is none. */
export function nextCheckText(next: WatchNextCheck): string {
  switch (next.state) {
    case 'scheduled':
      return untilText(next.at);
    case 'due':
      return 'due now';
    case 'offline':
      return 'daemon offline';
    case 'unknown':
      return 'Unknown';
    default:
      return next.state;
  }
}

/** Line 3: when it last tried, and when it next will. */
function timing(row: WatchInventoryRow): Children {
  return [
    'Last check ',
    row.lastAttemptAt ? [Age(row.lastAttemptAt), ' ago'] : 'Never',
    ' · Next ',
    nextCheckText(row.next),
    row.deliveryHeld && ' · delivery held, still checking',
  ];
}

const ownerText = (row: WatchInventoryRow): string =>
  (row.owner.name ?? (row.owner.kind === 'trap' ? `wt:${row.owner.id}` : row.owner.id)) + (row.boat ? ` · ${row.boat}` : '');

/** What the expanded card shows: exact times, the source and the watch's identity. */
function details(row: WatchInventoryRow): Children {
  const rows: Array<[string, Children]> = [
    ['Last attempt', row.lastAttemptAt ?? 'Never'],
    ['Last success', row.lastSuccessAt ?? 'Never'],
    ['Next check', row.next.state === 'scheduled' ? `${row.next.at} (estimate)` : nextCheckText(row.next)],
    ['Source', `${row.source.name} · ${row.type}${row.version ? ` ${row.version}` : ''}`],
    ['Status', row.status],
    ['Watch', row.key],
    ['Owner', `${ownerText(row)} (${row.owner.kind}, ${row.owner.grounds})`],
    ...(row.deliveryHeld
      ? ([['Delivery held', `${row.deliveryHeld.since}${row.deliveryHeld.reason ? ` · ${row.deliveryHeld.reason}` : ''}`]] as Array<
          [string, Children]
        >)
      : []),
    ...(row.error ? ([['Failures in a row', String(row.error.failures)]] as Array<[string, Children]>) : []),
    ...row.links.map((link): [string, Children] => [link.label, html`<a href=${link.url} target="_blank" rel="noopener">${link.url}</a>`]),
  ];
  return html`<dl class="watch-details">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/** One watch as the record card: title and kind, health, Open; source logo and owner; timing; the latest error and remedy. */
export function watchCard(row: WatchInventoryRow): Children {
  const health = HEALTH[row.health];
  const link = row.links[0];
  return ExpandingCard({
    title: row.title,
    titleAttr: row.key,
    icon: row.glyph && html`<${Glyph} glyph=${row.glyph} />`,
    state: { word: health.word, tone: health.tone, mark: 'chip' },
    ...(link ? { open: { href: link.url, label: 'Open watch' } } : {}),
    lead: html`<${SourceLogo} source=${row.source} />`,
    context: [' · ', ownerText(row), row.derived && ' · derived view'],
    contextTitle: `${row.source.name} · ${ownerText(row)}`,
    now: timing(row),
    ...(row.error ? { foot: { left: [row.error.message, row.error.remedy && ` ${row.error.remedy}`] } } : {}),
    cls: 'watchcard',
    attrs: { 'data-watch': row.key },
    more: details(row),
  });
}

function row(entry: WatchInventoryRow): Children {
  const health = HEALTH[entry.health];
  return html`<tr key=${entry.key} data-watch=${entry.key}>
    <td><span class="glead"><${SourceLogo} source=${entry.source} /></span></td>
    <td class="grow" title=${entry.key}>${entry.title}${entry.derived && html` <span class="dim">derived view</span>`}</td>
    <td>${ownerText(entry)}</td>
    <td>${entry.lastAttemptAt ? [Age(entry.lastAttemptAt), ' ago'] : 'Never'}</td>
    <td>${nextCheckText(entry.next)}</td>
    <td><span class=${'gchip ' + health.tone}>${health.word}</span></td>
    <td>${entry.error && [entry.error.message, entry.error.remedy && html` <span class="dim">${entry.error.remedy}</span>`]}</td>
  </tr>`;
}

/** Group rows by source, keeping each group's latest-check order; groups are in a stable order by name. */
export function watchGroups(rows: readonly WatchInventoryRow[]): Array<{ source: WatchInventoryRow['source']; rows: WatchInventoryRow[] }> {
  const groups = new Map<string, { source: WatchInventoryRow['source']; rows: WatchInventoryRow[] }>();
  for (const entry of rows) {
    const group = groups.get(entry.source.id) ?? { source: entry.source, rows: [] };
    group.rows.push(entry);
    groups.set(entry.source.id, group);
  }
  return [...groups.values()].sort((a, b) => a.source.name.localeCompare(b.source.name) || a.source.id.localeCompare(b.source.id));
}

const list = (rows: WatchInventoryRow[], view: SectionInputs['watches']['view']): Children =>
  view === 'cards'
    ? html`<div class="cards">${rows.map(watchCard)}</div>`
    : Table(['source', 'watch', 'owner', 'last check', 'next', 'health', 'error'], rows.map(row), 'no watches match');

/** The page: the Source | Timestamp control and filters, then the watches in the chosen order. */
export function Watches({ inp }: { inp: SectionInputs['watches'] }): Children {
  if (!inp.rows) return html`<p class="empty">This boat does not list its watches yet.</p>`;
  const controls = html`<div class="tabhead watch-controls">
    <div class="seg" role="group" aria-label="Order watches by">
      ${(['source', 'timestamp'] as const).map(
        (order) =>
          html`<${Button} key=${order} pressed=${inp.order === order} onClick=${() => setPrefs({ watchOrder: order })}>${order === 'source' ? 'Source' : 'Timestamp'}<//>`,
      )}
    </div>
    <select aria-label="Owner" value=${inp.owner ?? ''} onChange=${(event: Event) => setPrefs({ watchOwner: ((event.target as HTMLSelectElement).value || undefined) as SectionInputs['watches']['owner'] })}>
      <option value="">every owner</option><option value="helm">helms</option><option value="dispatch">dispatches</option><option value="trap">traps</option>
    </select>
    <select aria-label="Health" value=${inp.health ?? ''} onChange=${(event: Event) => setPrefs({ watchHealth: ((event.target as HTMLSelectElement).value || undefined) as SectionInputs['watches']['health'] })}>
      <option value="">any health</option>
      ${(Object.keys(HEALTH) as WatchHealthState[]).map((state) => html`<option value=${state}>${HEALTH[state].word}</option>`)}
    </select>
  </div>`;
  const caption = html`<p class="dim watch-caption">${inp.order === 'source' ? 'Grouped by source' : 'Latest check first'}</p>`;
  if (!inp.rows.length) return [controls, caption, html`<p class="empty">${inp.total ? 'No watches match' : 'No watches are active'}</p>`];
  if (inp.order === 'timestamp') return [controls, caption, list(inp.rows, inp.view)];
  return [
    controls,
    caption,
    ...watchGroups(inp.rows).map(
      (group) =>
        html`<section class="watch-source" data-watch-source=${group.source.id}>
          <h2 class="watch-source-head"><span class="glead"><${SourceArt} source=${group.source} /></span><span>${group.source.name}</span> <span class="dim">${group.rows.length}</span></h2>
          ${list(group.rows, inp.view)}
        </section>`,
    ),
  ];
}
