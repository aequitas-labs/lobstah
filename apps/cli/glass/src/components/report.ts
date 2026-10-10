import type { GlassReport } from '@lobstah/core';
import { MarkdownElements } from './markdown.js';
import { reportFileUrl, reportFrom } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { Age, ImageThumb, attachmentRows, cmdRow } from './common.js';

type FileUrl = (name: string) => string;
const markdown = (text: string, fileUrl: FileUrl) =>
  html`<${MarkdownElements} text=${text} image=${(name: string, alt: string) => ImageThumb(fileUrl(name), alt, 'mdimg')} />`;

/** The page body for one report's markdown, or the loading and error states. */
export function ReportPage({ r, text }: { r: GlassReport; text: { text?: string; error?: string } | undefined }) {
  const body =
    text?.text !== undefined
      ? markdown(text.text, (name) => reportFileUrl(r.key, name))
      : text?.error
        ? html`<div class="bad">${text.error}</div>`
        : html`<div class="dim">loading…</div>`;
  return html`<div class="mdpage" data-report=${r.key}>${body}</div>`;
}

/** Markdown as elements, with images from `fileUrl` (a decision's detail page). */
export function Markdown({ text, fileUrl }: { text: string; fileUrl: FileUrl }) {
  return html`<div class="mdpage">${markdown(text, fileUrl)}</div>`;
}

/** The report's heading line: who it is from (a trap, a headless dispatch's id, nothing for the helm), its age, and `acked`. */
export function reportByline(r: GlassReport): Children {
  const from = reportFrom(r);
  return [from && from + ' · ', Age(r.filedAt), ' ago', r.acked && [' · ', html`<span class="ok">acked</span>`]];
}

/** The report section a modal shows: byline, page, its own attachments, and the ack command. */
export function ReportSection({
  r,
  text,
  heading,
}: {
  r: GlassReport;
  text: { text?: string; error?: string } | undefined;
  heading?: boolean;
}) {
  return [
    heading && html`<div class="sec">report · ${r.title}</div>`,
    html`<div class="sub">${reportByline(r)}</div>`,
    html`<${ReportPage} r=${r} text=${text} />`,
    r.attachments.length > 0 && [
      html`<div class="sec">report attachments (${r.attachments.length})</div>`,
      attachmentRows(r.attachments, (name) => reportFileUrl(r.key, name)),
    ],
    !r.acked && [html`<div class="sec">ack</div>`, cmdRow('lobstah attention ack ' + r.key)],
  ];
}
