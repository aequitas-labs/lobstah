import type { GlassReport } from '@lobstah/core';
import { reportMarkdownUrl } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Lightbox } from '../store.js';
import { LightboxView } from './lightbox.js';
import { ReportSection } from './report.js';

/**
 * A report on its own page (`/report/<key>`): fetched once and rendered
 * once. It never polls, so nothing re-renders while a person reads it.
 * Opening it does not ack the report.
 */

export type ReportViewState =
  { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; report: GlassReport; text?: string; error?: string };

export function ReportView({ view }: { view: ReportViewState }) {
  if (view.state === 'loading') return html`<main class="reportview"><div class="dim">loading…</div></main>`;
  if (view.state === 'error') return html`<main class="reportview"><div class="bad">${view.error}</div></main>`;
  const r = view.report;
  return html`<main class="reportview">
    <h1>${r.title}</h1>
    <${ReportSection} r=${r} text=${view.text !== undefined ? { text: view.text } : { error: view.error }} />
  </main>`;
}

/** The report page with the shared image overlay above it. */
export function ReportShell({ view, box }: { view: ReportViewState; box: Lightbox | null }) {
  return [html`<${ReportView} view=${view} />`, html`<${LightboxView} box=${box} />`];
}

/** Load a report's row and markdown once. */
export async function loadReportView(key: string): Promise<ReportViewState> {
  const enc = encodeURIComponent(key);
  let report: GlassReport;
  try {
    const res = await fetch(`/report/${enc}/meta`);
    if (!res.ok) return { state: 'error', error: `report not found (${res.status})` };
    report = JSON.parse(await res.text()) as GlassReport;
  } catch {
    return { state: 'error', error: 'report could not be read' };
  }
  try {
    const res = await fetch(reportMarkdownUrl(key));
    return res.ok
      ? { state: 'ready', report, text: await res.text() }
      : { state: 'ready', report, error: `report not found (${res.status})` };
  } catch {
    return { state: 'ready', report, error: 'report could not be read' };
  }
}
