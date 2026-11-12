import type { GlassReport } from '@lobstah/core';
import { backend } from '../backend.js';
import { html } from '../html.js';
import { getState } from '../store.js';
import type { Lightbox } from '../store.js';
import { LightboxView } from './lightbox.js';
import { ReportSection } from './report.js';
import { LinkedText } from './links.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { closeReportSheet } from '../actions.js';
import { buttonClass } from './button.js';

/**
 * A report on its own page (`/report/<key>`): fetched once and rendered
 * once. Only checklist state refreshes while a person reads it.
 * Showing it acks the report (`report-viewed`); the page stays as rendered.
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
    <h1>${LinkedText(r.title)}</h1>
    <${ReportSection} r=${r} token=${view.token} text=${view.text !== undefined ? { text: view.text } : { error: view.error }} />
  </main>`;
}

/**
 * A report in the sheet over the glass: a bar with Back and its title, then
 * the report as its own page shows it. It loads when its key changes, acks
 * the report once its text shows, and gives focus to Back. The tab
 * underneath keeps its place, so Back (or the back gesture) returns to it.
 */
export function ReportSheet({ reportKey }: { reportKey: string | null }) {
  const [view, setView] = useState<ReportViewState>({ state: 'loading' });
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reportKey) return;
    let live = true;
    setView({ state: 'loading' });
    back.current?.focus();
    void loadReportView(reportKey).then((loaded) => {
      if (!live) return;
      setView(loaded);
      void markReportViewed(loaded);
    });
    return () => {
      live = false;
    };
  }, [reportKey]);
  if (!reportKey) return null;
  // The snapshot already names it, so the bar has its title before the report loads.
  const title =
    view.state === 'ready' ? view.report.title : (getState().snapshot?.reports?.find((r) => r.key === reportKey)?.title ?? 'Report');
  return html`<div class="rsheet" role="dialog" aria-modal="true" aria-labelledby="rsheet-title">
    <div class="rbar"><button type="button" class=${buttonClass('secondary', 'md', 'rback')} ref=${back} onClick=${closeReportSheet}>‹ Back</button><b id="rsheet-title" class="rbartitle">${LinkedText(title)}</b></div>
    <div class="rbody"><${ReportView} view=${view} /></div>
  </div>`;
}

/** The report page with the shared image overlay above it. */
export function ReportShell({ view, box }: { view: ReportViewState; box: Lightbox | null }) {
  return [html`<${ReportView} view=${view} />`, html`<${LightboxView} box=${box} />`];
}

/** Load a report's row and markdown once. */
export async function loadReportView(key: string): Promise<ReportViewState> {
  let report: GlassReport;
  let token: string | undefined;
  try {
    const res = await backend().report(key);
    if (!res.ok) return { state: 'error', error: `report not found (${res.status})` };
    token = res.token;
    report = res.data;
  } catch {
    return { state: 'error', error: 'report could not be read' };
  }
  try {
    const res = await backend().reportText(key);
    const page = res.ok ? { text: res.data } : { error: `report not found (${res.status})` };
    return { state: 'ready', report, ...page, ...(token ? { token } : {}) };
  } catch {
    return { state: 'ready', report, error: 'report could not be read' };
  }
}

/**
 * The page showed a report's text: ack this filing on the server
 * (`report-viewed`, the guarded path a decision's view takes). State only:
 * it wakes no one and changes nothing on the page. Nothing to do when the
 * report is already acked, its text did not load, or the page has no token.
 */
export async function markReportViewed(view: ReportViewState): Promise<void> {
  if (view.state !== 'ready' || view.text === undefined || view.report.acked || !view.token) return;
  try {
    await backend().request('report-viewed', { key: view.report.key }, view.token);
  } catch {
    // The next open tries again.
  }
}
