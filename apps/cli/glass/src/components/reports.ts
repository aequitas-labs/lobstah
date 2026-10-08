import type { GlassReport } from '@lobstah/core';
import { reportFrom, reportPageUrl } from '../../../src/glass-diff.js';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import { Age, Table, ageText } from './common.js';

/**
 * The Reports tab: every report, unacked first, then newest first. A card or
 * row says who filed it (a trap's name, a headless dispatch's id, nothing for
 * the helm), then its age, then `acked`. Each opens the report's own page in
 * a new tab.
 */

/** Open a report's own page in a new tab. Opening it does not ack it. */
export const openReport = (r: GlassReport) => () => {
  window.open(reportPageUrl(r.key), '_blank', 'noopener');
};

/** The meta line as elements (the age ticks) and as text (the clamped line's title). */
export function reportMeta(r: GlassReport): { nodes: unknown[]; text: string } {
  const from = reportFrom(r);
  return {
    nodes: [from && from + ' · ', Age(r.filedAt), ' ago', r.acked ? ' · acked' : ''],
    text: [from, `${ageText(r.filedAt)} ago`, r.acked ? 'acked' : ''].filter(Boolean).join(' · '),
  };
}

function card(r: GlassReport) {
  const meta = reportMeta(r);
  return html`<a key=${r.key} class=${'card' + (r.acked ? ' acked' : '')} href=${reportPageUrl(r.key)} target="_blank" rel="noopener"><div class="top"><b title=${r.title}>${r.title}</b></div><div class="meta" title=${meta.text}>${meta.nodes}</div></a>`;
}

function row(r: GlassReport) {
  return html`<tr key=${r.key} class=${'rowhead' + (r.acked ? ' acked' : '')} onClick=${openReport(r)}><td class="grow"><a href=${reportPageUrl(r.key)} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>${r.title}</a></td><td>${reportFrom(r)}</td><td>${Age(r.filedAt)}</td><td>${r.acked ? 'acked' : ''}</td></tr>`;
}

export function Reports({ inp }: { inp: SectionInputs['reports'] }) {
  if (inp.view === 'cards')
    return inp.list.length ? html`<div class="cards">${inp.list.map(card)}</div>` : html`<div class="empty">no reports match</div>`;
  return Table(['title', 'from', 'filed', 'acked'], inp.list.map(row), 'no reports match');
}
