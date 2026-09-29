import type { GlassReport } from '@lobstah/core';
import { bareImageName, parseMarkdown, safeHref } from '../../../src/glass-markdown.js';
import type { MdBlock, MdInline } from '../../../src/glass-markdown.js';
import { reportFileUrl } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { Age, attachmentRows, cmdRow } from './common.js';

/**
 * A report page: its markdown as elements. Text stays text (raw HTML shows
 * as written), links open in a new tab, and an image loads only from the
 * report's own attachments by bare filename.
 */

function inline(key: string, nodes: MdInline[]): Children {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return html`<code>${n.v}</code>`;
      case 'b':
        return html`<strong>${inline(key, n.c)}</strong>`;
      case 'i':
        return html`<em>${inline(key, n.c)}</em>`;
      case 'br':
        return html`<br />`;
      case 'a': {
        const href = safeHref(n.href);
        return href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${inline(key, n.c)}</a>` : inline(key, n.c);
      }
      case 'img': {
        const name = bareImageName(n.src);
        return name
          ? html`<img src=${reportFileUrl(key, name)} alt=${n.alt} loading="lazy" />`
          : html`<span class="dim">[image not shown: ${n.alt || n.src}]</span>`;
      }
    }
  });
}

function blocks(key: string, list: MdBlock[]): Children {
  return list.map((b) => {
    switch (b.t) {
      case 'h': {
        const c = inline(key, b.c);
        return b.level === 1
          ? html`<h1>${c}</h1>`
          : b.level === 2
            ? html`<h2>${c}</h2>`
            : b.level === 3
              ? html`<h3>${c}</h3>`
              : html`<h4>${c}</h4>`;
      }
      case 'p':
        return html`<p>${inline(key, b.c)}</p>`;
      case 'code':
        return html`<pre class="mdcode"><code>${b.v}</code></pre>`;
      case 'hr':
        return html`<hr />`;
      case 'quote':
        return html`<blockquote>${blocks(key, b.c)}</blockquote>`;
      case 'list': {
        const items = b.items.map((it) => html`<li>${blocks(key, it)}</li>`);
        return b.ordered ? html`<ol start=${b.start}>${items}</ol>` : html`<ul>${items}</ul>`;
      }
      case 'table':
        return html`<div class="mdtable"><table><thead><tr>${b.head.map((c, i) => html`<th style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(key, c)}</th>`)}</tr></thead><tbody>${b.rows.map(
          (row) =>
            html`<tr>${row.map((c, i) => html`<td style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(key, c)}</td>`)}</tr>`,
        )}</tbody></table></div>`;
    }
  });
}

/** The page body for one report's markdown, or the loading and error states. */
export function ReportPage({ r, text }: { r: GlassReport; text: { text?: string; error?: string } | undefined }) {
  const body =
    text?.text !== undefined
      ? blocks(r.key, parseMarkdown(text.text))
      : text?.error
        ? html`<div class="bad">${text.error}</div>`
        : html`<div class="dim">loading…</div>`;
  return html`<div class="mdpage" data-report=${r.key}>${body}</div>`;
}

/** The report's heading line: author, when it was filed, and its ack. */
export function reportByline(r: GlassReport): Children {
  return [
    r.author,
    r.grounds && ' · grounds ' + r.grounds,
    ' · filed ',
    Age(r.filedAt),
    ' ago · ',
    r.acked ? html`<span class="ok">acked by ${r.acked.by}</span>` : html`<span class="warn">not acked</span>`,
  ];
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
    r.attachments.length > 0 && [html`<div class="sec">report attachments (${r.attachments.length})</div>`, attachmentRows(r.attachments)],
    !r.acked && [html`<div class="sec">ack</div>`, cmdRow('lobstah attention ack ' + r.key)],
  ];
}
