import type { GlassReport } from '@lobstah/core';
import { reportMarkdownUrl } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Lightbox } from '../store.js';
import { LightboxView } from './lightbox.js';
import { ReportSection } from './report.js';

/**
 * A report on its own page (`/report/<key>`): fetched once and rendered
 * once. It never polls, so nothing re-renders while a person reads it.
 * Showing it acks the report (`report-viewed`): the one repaint after that
 * marks it acked.
 */

export type ReportViewState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; report: GlassReport; text?: string; error?: string; token?: string };

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
  let token: string | undefined;
  try {
    const res = await fetch(`/report/${enc}/meta`);
    if (!res.ok) return { state: 'error', error: `report not found (${res.status})` };
    token = res.headers?.get('x-lobstah-token') ?? undefined;
    report = JSON.parse(await res.text()) as GlassReport;
  } catch {
    return { state: 'error', error: 'report could not be read' };
  }
  try {
    const res = await fetch(reportMarkdownUrl(key));
    const page = res.ok ? { text: await res.text() } : { error: `report not found (${res.status})` };
    return { state: 'ready', report, ...page, ...(token ? { token } : {}) };
  } catch {
    return { state: 'ready', report, error: 'report could not be read' };
  }
}

/**
 * The page showed a report's text: ack this filing on the server
 * (`report-viewed`, the guarded path a decision's view takes). State only:
 * it wakes no one. Returns the view with the ack, or as it was when the
 * report was already acked, has no text, or the write failed.
 */
export async function markReportViewed(view: ReportViewState): Promise<ReportViewState> {
  if (view.state !== 'ready' || view.text === undefined || view.report.acked || !view.token) return view;
  try {
    const res = await fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobstah-token': view.token },
      body: JSON.stringify({ kind: 'report-viewed', payload: { key: view.report.key } }),
    });
    if (!res.ok) return view;
    const body = (await res.json()) as { viewedAt?: string; by?: string };
    if (!body.viewedAt) return view;
    return { ...view, report: { ...view.report, acked: { at: body.viewedAt, by: body.by ?? 'glass' } } };
  } catch {
    // The next open tries again.
    return view;
  }
}
