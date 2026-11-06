import type { ChecklistProgress } from '../../../core/src/checklist-types.js';
import { imageDisplay, markdownImageSources, markdownTasks, parseMarkdown, safeHref } from '../../src/glass-markdown.js';
import type { ImageSurface, MdBlock, MdInline } from '../../src/glass-markdown.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.js';
import { checklistSource, hasChecklistSource } from '../checklists.js';
import type { Children } from '../html.js';

/** Shared safe Markdown: raw HTML stays text; images resolve to owned files, or to https on a card. */
type Image = (name: string, alt: string) => Children;

/** Opens an image larger, in the page's own overlay. */
type OpenImage = (src: string, alt: string) => void;

/** How one Markdown body renders: where its images come from, and whether its code can be copied. */
interface RenderOptions {
  image: Image;
  surface: ImageSurface;
  openImage?: OpenImage;
  copyCode: boolean;
  checklist?: { progress?: ChecklistProgress; pending: boolean; readOnly: boolean; toggle: (id: string, checked: boolean) => void };
}

/** What a copy control shows and says in each state. */
const COPY_NOTE = {
  idle: { icon: '⧉', title: 'Copy' },
  copied: { icon: '✓', title: 'Copied' },
  selected: { icon: '✓', title: 'Selected, ready to copy' },
};

/** How long a control says what just happened. */
const COPY_NOTE_MS = 1500;

/**
 * Copies exactly `text`. The clipboard is missing on a plain HTTP address off
 * the machine, and a browser can refuse it: then the code is selected instead,
 * ready to copy by hand.
 */
function useCopy(text: string) {
  const [state, setState] = useState<keyof typeof COPY_NOTE>('idle');
  const code = useRef<HTMLElement>(null);
  const copy = async () => {
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
  return { state, code, copy };
}

/** A fenced block with an icon button floating over its top-right corner. */
function CopyableBlock({ text }: { text: string }) {
  const { state, code, copy } = useCopy(text);
  const note = COPY_NOTE[state];
  const click = (e: Event) => {
    e.stopPropagation();
    void copy();
  };
  return html`<div class="mdcodewrap"><pre class="mdcode"><code ref=${code}>${text}</code></pre><button type="button" class="copybtn" title=${note.title} aria-label=${note.title} onClick=${click}>${note.icon}</button></div>`;
}

/**
 * Inline code that copies when clicked or tapped, so a sentence keeps its exact
 * layout: a hover control wouldn't work on a phone. A drag across the code is
 * someone selecting part of it, and stays theirs.
 */
function CopyableInline({ text }: { text: string }) {
  const { state, code, copy } = useCopy(text);
  const click = (e: Event) => {
    e.stopPropagation();
    const selection = window.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      (code.current?.contains(selection.anchorNode) || code.current?.contains(selection.focusNode))
    )
      return;
    void copy();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    void copy();
  };
  return html`<code ref=${code} class=${'copyinline' + (state === 'idle' ? '' : ' copied')} role="button" tabindex="0" title=${COPY_NOTE[state].title} onClick=${click} onKeyDown=${key}>${text}</code>`;
}

/**
 * A card's remote https image, loaded lazily with no referrer, that opens
 * with `open` when given. One that fails to load (a private repo's raw URL,
 * say) becomes a plain link to the URL, its alt text as the label.
 */
function RemoteImage({ url, alt, open }: { url: string; alt: string; open?: OpenImage }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) return html`<a href=${url} target="_blank" rel="noopener noreferrer" title=${url}>${alt || url}</a>`;
  const img = html`<img src=${url} alt=${alt} loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`;
  if (!open) return img;
  const click = (e: Event) => {
    e.stopPropagation();
    open(url, alt || url);
  };
  return html`<button type="button" class="mdimg" title=${'view ' + (alt || url)} onClick=${click}>${img}</button>`;
}

function inline(options: RenderOptions, nodes: MdInline[]): Children {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return options.copyCode ? html`<${CopyableInline} text=${n.v} />` : html`<code>${n.v}</code>`;
      case 'b':
        return html`<strong>${inline(options, n.c)}</strong>`;
      case 'i':
        return html`<em>${inline(options, n.c)}</em>`;
      case 'br':
        return html`<br />`;
      case 'a': {
        const href = safeHref(n.href);
        // Code inside a link stays the link: its click opens it.
        return href
          ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${inline({ ...options, copyCode: false }, n.c)}</a>`
          : inline(options, n.c);
      }
      case 'img': {
        const shown = imageDisplay(n.src, options.surface);
        switch (shown?.kind) {
          case 'attachment':
            return options.image(shown.name, n.alt || shown.name);
          case 'remote':
            return html`<${RemoteImage} url=${shown.url} alt=${n.alt} open=${options.openImage} />`;
          case 'link':
            return html`<a href=${shown.url} target="_blank" rel="noopener noreferrer">${n.alt || shown.url}</a>`;
          default:
            return html`<span class="dim">[image not shown: ${n.alt || n.src}]</span>`;
        }
      }
    }
  });
}
function blocks(options: RenderOptions, list: MdBlock[]): Children {
  return list.map((b) => {
    switch (b.t) {
      case 'task': {
        const state = options.checklist;
        const checked = state?.progress?.items.find((item) => item.id === b.id)?.checked ?? b.checked;
        return html`<label class="mdtask" onClick=${(event: Event) => event.stopPropagation()}><input type="checkbox" aria-label=${b.text} checked=${checked} disabled=${!state?.progress || state.pending || state.readOnly || state.progress.readOnly} onChange=${(event: Event) => state?.toggle(b.id, (event.target as HTMLInputElement).checked)} /><span>${inline({ ...options, copyCode: false }, b.c)}</span></label>`;
      }
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
        return options.copyCode ? html`<${CopyableBlock} text=${b.v} />` : html`<pre class="mdcode"><code>${b.v}</code></pre>`;
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

/** The parsed tree for `text`, from a small cache of recent bodies. */
function parsedMarkdown(text: string): MdBlock[] {
  let tree = parsed.get(text);
  if (!tree) {
    tree = parseMarkdown(text);
    parsed.set(text, tree);
    if (parsed.size > 8) parsed.delete(parsed.keys().next().value!);
  }
  return tree;
}

/** The attachment names a Markdown body shows inline, so its attachment list can leave them out. */
export function inlineAttachmentNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const src of markdownImageSources(parsedMarkdown(text))) {
    const shown = imageDisplay(src, 'report');
    if (shown?.kind === 'attachment') names.add(shown.name);
  }
  return names;
}

/** Render Markdown, synchronizing task state only for a stored document. */
export function MarkdownElements({
  text,
  image,
  surface = 'report',
  openImage,
  copyCode = false,
  documentKey,
  token,
  readOnly = false,
}: {
  text: string;
  image: Image;
  /** A card loads remote https images; a report shows them as links. */
  surface?: ImageSurface;
  /** Where a remote image opens larger when clicked. */
  openImage?: OpenImage;
  copyCode?: boolean;
  documentKey?: string;
  token?: string;
  readOnly?: boolean;
}): Children {
  const tree = parsedMarkdown(text);
  const hasTasks = markdownTasks(tree).length > 0;
  const [progress, setProgress] = useState<ChecklistProgress>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setError('');
    setProgress(undefined);
    if (!documentKey || !hasTasks || !hasChecklistSource()) return;
    let disposed = false;
    const load = async () => {
      if (saving.current || document.hidden) return;
      const version = revision.current;
      try {
        const response = await checklistSource().load(documentKey);
        if (!response.ok) throw new Error('Checklist could not be loaded.');
        const stored = response.data;
        if (!disposed && !saving.current && version === revision.current) {
          setProgress(stored);
          setError('');
        }
      } catch {
        if (!disposed) setError('Checklist could not be loaded.');
      }
    };
    void load();
    const interval = setInterval(() => void load(), 2000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [documentKey, text, hasTasks]);
  const toggle = async (id: string, checked: boolean) => {
    if (!documentKey || !progress || progress.readOnly || readOnly || saving.current) return;
    const previous = progress;
    saving.current = true;
    const version = ++revision.current;
    setPending(true);
    setError('');
    setProgress({ ...progress, items: progress.items.map((item) => (item.id === id ? { ...item, checked } : item)) });
    try {
      const response = await checklistSource().tick(documentKey, id, checked, token ?? '');
      const stored = response.body;
      if (!response.ok || !stored.ok) throw new Error(stored.reason ?? 'Checklist could not be saved.');
      if (version === revision.current) setProgress(stored);
    } catch (failure) {
      if (version === revision.current) {
        setProgress(previous);
        setError(failure instanceof Error ? failure.message : 'Checklist could not be saved.');
      }
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  return [
    blocks(
      {
        image,
        surface,
        openImage,
        copyCode,
        checklist: { progress, pending, readOnly, toggle: (id, checked) => void toggle(id, checked) },
      },
      tree,
    ),
    error && html`<p class="bad" role="alert">${error}</p>`,
  ];
}
