import { useEffect, useState } from 'preact/hooks';
import type { GlassReport } from '@lobstah/core';
import { reportFrom, reportPageUrl } from '../../src/glass-diff.js';
import type { SectionInputs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import { openReportSheet } from '../actions.js';
import { Age, RepoName, TRAP_MARK, Table, ageText } from './common.js';
import { Card, OpenArrow, OpenIcon } from './card.js';

/**
 * The Reports tab: every report, newest first regardless of acknowledgment.
 * A card shows the title, then its repo, who filed it (a trap's name, a
 * headless dispatch's id, nothing for the helm) and its age, with ↗ Open; it
 * is greyed once read. A row says `acked` instead. Each opens the report in
 * the sheet over the glass, in a browser tab and in the installed app alike.
 */

/** Whether a click asked for a new tab (⌘, ctrl, shift or a middle click): the link's own target then. */
const newTab = (e?: Event): boolean => {
  const m = e as MouseEvent | undefined;
  return !!m && (m.metaKey || m.ctrlKey || m.shiftKey || m.button === 1);
};

/** Open a report in the sheet over the glass. Showing it acknowledges it once its text loads. */
export const openReport = (r: GlassReport) => (e?: Event) => {
  if (newTab(e)) return;
  e?.preventDefault();
  openReportSheet(r.key);
};

/** The meta line as elements (the age ticks) and as text (the clamped line's title). */
export function reportMeta(r: GlassReport): { nodes: unknown[]; text: string } {
  const from = reportFrom(r);
  return {
    nodes: [from && from + ' · ', Age(r.filedAt), ' ago', r.acked ? ' · acked' : ''],
    text: [from, `${ageText(r.filedAt)} ago`, r.acked ? 'acked' : ''].filter(Boolean).join(' · '),
  };
}

/** Keep phone arrows and table columns in sync when the viewport changes. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(innerWidth < 700);
  useEffect(() => {
    const resize = () => setPhone(innerWidth < 700);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return phone;
}

const chevron = html`<span class="report-chevron" aria-hidden="true">›</span>`;

/** The phone's report disclosure, inside the link that opens its sheet. */
export function ReportChevron() {
  return usePhone() ? chevron : null;
}

function ReportIcon() {
  return usePhone() ? chevron : OpenIcon;
}

const reportDestination = (r: GlassReport) => ({
  href: reportPageUrl(r.key),
  label: 'Open the report',
  here: openReport(r),
  icon: html`<${ReportIcon} />`,
});

/** A report card: no status word; greyed once read (its page acks it). */
export function reportCard(r: GlassReport, onOpen?: () => void) {
  const from = reportFrom(r);
  const lead = [r.repo, from].filter(Boolean).join(' · ');
  const open = (event?: Event) => {
    if (!newTab(event)) onOpen?.();
    openReport(r)(event);
  };
  return html`<${Card}
    key=${r.key}
    title=${r.title}
    titleAttr=${r.title}
    context=${[r.repo && [RepoName(r.repo), ' · '], from && [r.trap ? `${TRAP_MARK} ${from}` : from, ' · '], Age(r.filedAt), ' ago']}
    contextTitle=${[lead, `${ageText(r.filedAt)} ago`].filter(Boolean).join(' · ')}
    open=${{ ...reportDestination(r), here: open }}
    quiet=${!!r.acked}
    cls=${r.acked ? 'acked report-card' : 'report-card'}
    onClick=${open}
  />`;
}

function row(r: GlassReport, phone: boolean) {
  return html`<tr key=${r.key} class=${'rowhead' + (r.acked ? ' acked' : '')} onClick=${openReport(r)}><td class="grow"><a href=${reportPageUrl(r.key)} target="_blank" rel="noopener" onClick=${(
    e: Event,
  ) => {
    e.stopPropagation();
    openReport(r)(e);
  }}>${r.title}</a></td><td>${reportFrom(r)}</td><td>${Age(r.filedAt)}</td><td>${r.acked ? 'acked' : ''}</td>${phone && html`<td><${OpenArrow} open=${reportDestination(r)} /></td>`}</tr>`;
}

export function Reports({ inp }: { inp: SectionInputs['reports'] }) {
  const phone = usePhone();
  if (inp.view === 'cards')
    return inp.list.length
      ? html`<div class="cards">${inp.list.map((report) => reportCard(report))}</div>`
      : html`<div class="empty">no reports match</div>`;
  return Table(
    ['title', 'from', 'filed', 'acked', ...(phone ? [''] : [])],
    inp.list.map((r) => row(r, phone)),
    'no reports match',
  );
}
