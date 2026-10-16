/**
 * Bare URLs in the glass's free text. Both glasses (the local spyglass and
 * the hosted wharf glass) and the shared markdown parser find links here, so
 * one set of rules decides what becomes a link:
 *
 * - only `http://` and `https://` with a host; no other scheme is ever a link
 * - a URL ends at whitespace, a quote, `<`, `>`, or a backtick
 * - trailing sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `*`) and an
 *   unbalanced closing `)`, `]`, or `}` stay text: `(see http://x/a)` links
 *   `http://x/a`, while `http://x/wiki/A_(b)` keeps its own parentheses
 * - a URL glued to a word (`xhttp://…`) is not a link
 * - text in a backtick code span stays text (`linkParts` only)
 *
 * The result is plain strings and URLs, never markup: the pages turn it into
 * text nodes and `<a>` elements, so text is escaped before anything is linked.
 * Keep this module free of Node imports: it is bundled into both pages.
 */

/** A run of plain text, or a URL the page may link. */
export type LinkPart = string | { url: string };

const START = /https?:\/\//iy;
const STOP = /[\s<>"'`\u0000-\u001f\u007f]/;
const TRAILING = /[.,;:!?*]/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The URL that starts at `s[i]`, if one does: its text, already trimmed. */
export function urlAt(s: string, i: number): string | undefined {
  START.lastIndex = i;
  if (!START.test(s)) return undefined;
  if (i > 0 && /[\p{L}\p{N}_]/u.test(s[i - 1]!)) return undefined;
  let end = START.lastIndex;
  while (end < s.length && !STOP.test(s[end]!)) end++;
  let url = s.slice(i, end);
  for (;;) {
    const last = url[url.length - 1]!;
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (CLOSERS[last] && count(url, CLOSERS[last]!) < count(url, last)) url = url.slice(0, -1);
    else break;
  }
  return safeUrl(url) ? url : undefined;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** An http(s) URL with a host, or undefined. */
export function safeUrl(url: string): string | undefined {
  if (!/^https?:\/\/[^/?#\s]/i.test(url)) return undefined;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plain text split into text and URLs, for the page to render as text nodes
 * and links. A backtick code span (`` `…` ``) stays text, URL and all.
 */
export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      const stop = end < 0 ? i + run.length : end + run.length;
      plain += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === 'h' || ch === 'H') {
      const url = urlAt(text, i);
      if (url) {
        if (plain) out.push(plain);
        plain = '';
        out.push({ url });
        i += url.length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  if (plain) out.push(plain);
  return out;
}
