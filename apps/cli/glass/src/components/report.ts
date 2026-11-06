import type { Attachment, GlassReport } from '@lobstah/core';
import type { ImageSurface } from '../../../src/glass-markdown.js';
import { MarkdownElements, inlineAttachmentNames } from './markdown.js';
import { getState } from '../store.js';
import { openLightbox } from '../actions.js';
import { reportFileUrl, reportFrom } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { Age, ImageThumb, attachmentRows, cmdRow } from './common.js';
import { LinkedText } from './links.js';

type FileUrl = (name: string) => string;
const markdown = (
  text: string,
  fileUrl: FileUrl,
  surface: ImageSurface,
  copyCode = false,
  documentKey?: string,
  token?: string,
  readOnly = false,
) =>
  html`<${MarkdownElements} text=${text} surface=${surface} openImage=${openLightbox} copyCode=${copyCode} documentKey=${documentKey} token=${token ?? getState().snapshot?.focusToken} readOnly=${readOnly} image=${(name: string, alt: string) => ImageThumb(fileUrl(name), alt, 'mdimg')} />`;

/**
 * The attachments a page does not already show inline: an image its markdown
 * names (directly, or by the name it had before a rename) stays out of the list.
 */
function attachmentsNotInline(
  text: string | undefined,
  attachments: readonly Attachment[],
  renamed?: Record<string, string>,
): Attachment[] {
  if (!text) return [...attachments];
  const inline = new Set([...inlineAttachmentNames(text)].map((name) => renamed?.[name] ?? name));
  return attachments.filter((a) => !inline.has(a.name));
}

/** The page body for one report's markdown, or the loading and error states. */
export function ReportPage({ r, text, token }: { r: GlassReport; text: { text?: string; error?: string } | undefined; token?: string }) {
  const body =
    text?.text !== undefined
      ? markdown(text.text, (name) => reportFileUrl(r.key, name), 'report', false, r.key, token)
      : text?.error
        ? html`<div class="bad">${text.error}</div>`
        : html`<div class="dim">loading…</div>`;
  return html`<div class="mdpage" data-report=${r.key}>${body}</div>`;
}

/** Markdown as elements, with images from `fileUrl` or https, and code that copies (a decision's detail page). */
export function Markdown({
  text,
  fileUrl,
  documentKey,
  readOnly,
}: {
  text: string;
  fileUrl: FileUrl;
  documentKey?: string;
  readOnly?: boolean;
}) {
  return html`<div class="mdpage">${markdown(text, fileUrl, 'card', true, documentKey, undefined, readOnly)}</div>`;
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
  token,
}: {
  r: GlassReport;
  text: { text?: string; error?: string } | undefined;
  heading?: boolean;
  token?: string;
}) {
  const listed = attachmentsNotInline(text?.text, r.attachments, r.renamed);
  return [
    heading && html`<div class="sec">report · ${LinkedText(r.title)}</div>`,
    html`<div class="sub">${reportByline(r)}</div>`,
    html`<${ReportPage} r=${r} text=${text} token=${token} />`,
    listed.length > 0 && [
      html`<div class="sec">report attachments (${listed.length})</div>`,
      attachmentRows(listed, (name) => reportFileUrl(r.key, name)),
    ],
    !r.acked && [html`<div class="sec">ack</div>`, cmdRow('lobstah attention ack ' + r.key)],
  ];
}
