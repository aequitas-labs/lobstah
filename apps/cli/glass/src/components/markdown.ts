import { bareImageName, parseMarkdown, safeHref } from '../../../src/glass-markdown.js';
import type { MdBlock, MdInline } from '../../../src/glass-markdown.js';
import { useRef, useState } from 'preact/hooks';
import { html } from '../html.js';
import type { Children } from '../html.js';

/** Shared safe Markdown: raw HTML stays text; images resolve only to owned files. */
type Image = (name: string, alt: string) => Children;

/** How one Markdown body renders: where its images come from, and whether its code offers a copy button. */
interface RenderOptions {
  image: Image;
  copyCode: boolean;
}

/** The button's words, for a block and for the small inline button. */
const COPY_LABEL = {
  idle: { block: 'Copy', inline: '⧉', title: 'Copy' },
  copied: { block: 'Copied', inline: '✓', title: 'Copied' },
  selected: { block: 'Selected', inline: '✓', title: 'Selected, ready to copy' },
};

/** How long the button says what just happened. */
const COPY_NOTE_MS = 1500;

/**
 * Code with a button that copies exactly its text. The clipboard is missing on
 * a plain HTTP address off the machine, and a browser can refuse it: then the
 * text is selected instead, ready to copy by hand.
 */
function CopyableCode({ text, block }: { text: string; block: boolean }) {
  const [state, setState] = useState<keyof typeof COPY_LABEL>('idle');
  const code = useRef<HTMLElement>(null);
  const copy = async (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      const selection = window.getSelection();
      if (code.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState('selected');
    }
    setTimeout(() => setState('idle'), COPY_NOTE_MS);
  };
  const label = COPY_LABEL[state];
  const button = html`<button type="button" class="copybtn" title=${label.title} aria-label=${label.title} onClick=${copy}>${block ? label.block : label.inline}</button>`;
  return block
    ? html`<div class="mdcodewrap"><pre class="mdcode"><code ref=${code}>${text}</code></pre>${button}</div>`
    : html`<span class="copycode"><code ref=${code}>${text}</code>${button}</span>`;
}

function inline(options: RenderOptions, nodes: MdInline[]): Children {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return options.copyCode ? html`<${CopyableCode} text=${n.v} block=${false} />` : html`<code>${n.v}</code>`;
      case 'b':
        return html`<strong>${inline(options, n.c)}</strong>`;
      case 'i':
        return html`<em>${inline(options, n.c)}</em>`;
      case 'br':
        return html`<br />`;
      case 'a': {
        const href = safeHref(n.href);
        return href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${inline(options, n.c)}</a>` : inline(options, n.c);
      }
      case 'img': {
        const name = bareImageName(n.src);
        return name ? options.image(name, n.alt || name) : html`<span class="dim">[image not shown: ${n.alt || n.src}]</span>`;
      }
    }
  });
}
function blocks(options: RenderOptions, list: MdBlock[]): Children {
  return list.map((b) => {
    switch (b.t) {
      case 'h': {
        const c = inline(options, b.c);
        return b.level === 1
          ? html`<h1>${c}</h1>`
          : b.level === 2
            ? html`<h2>${c}</h2>`
            : b.level === 3
              ? html`<h3>${c}</h3>`
              : html`<h4>${c}</h4>`;
      }
      case 'p':
        return html`<p>${inline(options, b.c)}</p>`;
      case 'code':
        return options.copyCode ? html`<${CopyableCode} text=${b.v} block=${true} />` : html`<pre class="mdcode"><code>${b.v}</code></pre>`;
      case 'hr':
        return html`<hr />`;
      case 'quote':
        return html`<blockquote>${blocks(options, b.c)}</blockquote>`;
      case 'list': {
        const items = b.items.map((it) => html`<li>${blocks(options, it)}</li>`);
        return b.ordered ? html`<ol start=${b.start}>${items}</ol>` : html`<ul>${items}</ul>`;
      }
      case 'table':
        return html`<div class="mdtable"><table><thead><tr>${b.head.map((c, i) => html`<th style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(options, c)}</th>`)}</tr></thead><tbody>${b.rows.map((row) => html`<tr>${row.map((c, i) => html`<td style=${b.align[i] ? 'text-align:' + b.align[i] : undefined}>${inline(options, c)}</td>`)}</tr>`)}</tbody></table></div>`;
    }
  });
}
const parsed = new Map<string, MdBlock[]>();
export function MarkdownElements({ text, image, copyCode = false }: { text: string; image: Image; copyCode?: boolean }) {
  let tree = parsed.get(text);
  if (!tree) {
    tree = parseMarkdown(text);
    parsed.set(text, tree);
    if (parsed.size > 8) parsed.delete(parsed.keys().next().value!);
  }
  return blocks({ image, copyCode }, tree);
}
