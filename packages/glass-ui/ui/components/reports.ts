import type { GlassReport } from '@lobstah/core';
import { reportFrom, reportPageUrl } from '../../src/glass-diff.js';
import type { SectionInputs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import { Age, RepoName, TRAP_MARK, Table, ageText } from './common.js';
import { Card } from './card.js';

/**
 * The Reports tab: every report, newest first regardless of acknowledgment.
 * A card shows the title, then its repo, who filed it (a trap's name, a
 * headless dispatch's id, nothing for the helm) and its age, with ↗ Open; it
 * is greyed once read. A row says `acked` instead. Each opens the report's
 * own page in a new tab.
 */

/** Open a report's own page in a new tab. Its page acknowledges it once the report text loads. */
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

/** A report card: no status word; greyed once read (its page acks it). */
export function reportCard(r: GlassReport) {
  const from = reportFrom(r);
  const lead = [r.repo, from].filter(Boolean).join(' · ');
  return html`<${Card}
    key=${r.key}
    title=${r.title}
    titleAttr=${r.title}
    context=${[r.repo && [RepoName(r.repo), ' · '], from && [r.trap ? `${TRAP_MARK} ${from}` : from, ' · '], Age(r.filedAt), ' ago']}
    contextTitle=${[lead, `${ageText(r.filedAt)} ago`].filter(Boolean).join(' · ')}
    open=${{ href: reportPageUrl(r.key), label: 'Open the report' }}
    quiet=${!!r.acked}
    cls=${r.acked ? 'acked' : undefined}
    onClick=${openReport(r)}
  />`;
}

function row(r: GlassReport) {
  return html`<tr key=${r.key} class=${'rowhead' + (r.acked ? ' acked' : '')} onClick=${openReport(r)}><td class="grow"><a href=${reportPageUrl(r.key)} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>${r.title}</a></td><td>${reportFrom(r)}</td><td>${Age(r.filedAt)}</td><td>${r.acked ? 'acked' : ''}</td></tr>`;
}

export function Reports({ inp }: { inp: SectionInputs['reports'] }) {
  if (inp.view === 'cards')
    return inp.list.length ? html`<div class="cards">${inp.list.map(reportCard)}</div>` : html`<div class="empty">no reports match</div>`;
  return Table(['title', 'from', 'filed', 'acked'], inp.list.map(row), 'no reports match');
}
