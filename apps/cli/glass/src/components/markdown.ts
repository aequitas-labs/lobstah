import { bareImageName, parseMarkdown, safeHref } from '../../../src/glass-markdown.js';
import type { MdBlock, MdInline } from '../../../src/glass-markdown.js';
import { html } from '../html.js';
import type { Children } from '../html.js';

/** Shared safe Markdown: raw HTML stays text; images resolve only to owned files. */
type Image = (name: string, alt: string) => Children;
function inline(image: Image, nodes: MdInline[]): Children {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return html`<code>${n.v}</code>`;
      case 'b':
        return html`<strong>${inline(image, n.c)}</strong>`;
      case 'i':
        return html`<em>${inline(image, n.c)}</em>`;
      case 'br':
        return html`<br />`;
      case 'a': {
        const href = safeHref(n.href);
        return href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${inline(image, n.c)}</a>` : inline(image, n.c);
      }
      case 'img': {
        const name = bareImageName(n.src);
        return name ? image(name, n.alt || name) : html`<span class="dim">[image not shown: ${n.alt || n.src}]</span>`;
      }
    }
  });
}
function blocks(image: Image, list: MdBlock[]): Children {
  return list.map((b) => {
    switch (b.t) {
      case 'h': {
        const c = inline(image, b.c);
        return b.level === 1
          ? html`<h1>${c}</h1>`
          : b.level === 2
            ? html`<h2>${c}</h2>`
            : b.level === 3
              ? html`<h3>${c}</h3>`
              : html`<h4>${c}</h4>`;
      }
      case 'p':
        return html`<p>${inline(image, b.c)}</p>`;
      case 'code':
        return html`<pre class="mdcode"><code>${b.v}</code></pre>`;
      case 'hr':
        return html`<hr />`;
      case 'quote':
        return html`<blockquote>${blocks(image, b.c)}</blockquote>`;
      case 'list': {
        const items = b.items.map((it) => html`<li>${blocks(image, it)}</li>`);
        return b.ordered ? html`<ol start=${b.start}>${items}</ol>` : html`<ul>${items}</ul>`;
      }
      case 'table':
        return html`<div class="mdtable"><table><thead><tr>${b.head.map((c, i) => html`<th style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(image, c)}</th>`)}</tr></thead><tbody>${b.rows.map((row) => html`<tr>${row.map((c, i) => html`<td style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(image, c)}</td>`)}</tr>`)}</tbody></table></div>`;
    }
  });
}
const parsed = new Map<string, MdBlock[]>();
export function MarkdownElements({ text, image }: { text: string; image: Image }) {
  let tree = parsed.get(text);
  if (!tree) {
    tree = parseMarkdown(text);
    parsed.set(text, tree);
    if (parsed.size > 8) parsed.delete(parsed.keys().next().value!);
  }
  return blocks(image, tree);
}
