import { linkParts } from '../../../src/glass-links.js';
import { html } from '../html.js';
import type { Children } from '../html.js';

/**
 * Free text with its bare http(s) URLs as links, for both glasses. The text
 * stays text nodes (Preact escapes them); only a URL `glass-links.ts` accepts
 * becomes an `<a>`, opening in a new tab. A click on the link never reaches
 * the card, row, or option button around it.
 */

const stop = (e: Event) => e.stopPropagation();

/** One URL as a link; `label` is what it shows (a cut URL keeps its whole href). */
export const UrlLink = (url: string, label: string = url): Children =>
  html`<a class="autolink" href=${url} target="_blank" rel="noopener noreferrer" onClick=${stop}>${label}</a>`;

/**
 * Text with each bare URL as a link. Empty or missing text renders nothing.
 * With `max`, only the first `max` characters show; a URL cut there still
 * links to all of it.
 */
export function LinkedText(text: string | null | undefined, max = Infinity): Children[] {
  if (!text) return [];
  const out: Children[] = [];
  let budget = max;
  for (const p of linkParts(text)) {
    if (budget <= 0) break;
    const whole = typeof p === 'string' ? p : p.url;
    const shown = whole.length <= budget ? whole : whole.slice(0, budget);
    out.push(typeof p === 'string' ? shown : UrlLink(p.url, shown));
    budget -= whole.length;
  }
  return out;
}
