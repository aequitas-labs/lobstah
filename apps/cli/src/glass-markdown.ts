/**
 * The glass's markdown: a small parser for report pages. It returns a tree
 * of plain objects; the page turns the tree into elements, never into an
 * HTML string, so raw HTML in the markdown is text and no script can run.
 * It reads headings, paragraphs, fenced code, pipe tables, lists, block
 * quotes, rules, and inline code, links, images, bold, and italics. Keep
 * this module free of Node imports: it is bundled into the page.
 */

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; c: MdInline[] }
  | { t: 'i'; c: MdInline[] }
  | { t: 'a'; href: string; c: MdInline[] }
  | { t: 'img'; alt: string; src: string }
  | { t: 'br' };

export type MdBlock =
  | { t: 'h'; level: number; c: MdInline[] }
  | { t: 'p'; c: MdInline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: 'table'; align: Array<'left' | 'center' | 'right' | ''>; head: MdInline[][]; rows: MdInline[][][] }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'hr' };

/** A link the page may open: http(s), mailto, or an in-page anchor. Anything else is text. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:\/\/|mailto:|#)/i.test(h) ? h : undefined;
}

/**
 * An image the page may load: a bare filename in the report's attachments.
 * A path, a URL, or a data URI is refused.
 */
export function bareImageName(src: string): string | undefined {
  const s = src.trim();
  return /^[^/\\:?#]+$/.test(s) && s !== '.' && s !== '..' ? s : undefined;
}

// Inline -------------------------------------------------------------------

function findClose(s: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** `[text](target)` or `![alt](target)` starting at i (at the `[`). */
function bracketed(s: string, i: number): { text: string; target: string; end: number } | undefined {
  const close = findClose(s, i + 1, '[', ']');
  if (close < 0 || s[close + 1] !== '(') return undefined;
  const paren = findClose(s, close + 2, '(', ')');
  if (paren < 0) return undefined;
  const target = s.slice(close + 2, paren).trim().replace(/\s+"[^"]*"$/, '').replace(/^<(.*)>$/, '$1');
  return { text: s.slice(i + 1, close), target, end: paren + 1 };
}

export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: 'code', v: s.slice(i + run.length, end).replace(/^ (.*) $/, '$1') });
        i = end + run.length;
        continue;
      }
    }
    if (ch === '!' && s[i + 1] === '[') {
      const b = bracketed(s, i + 1);
      if (b) {
        flush();
        out.push({ t: 'img', alt: b.text, src: b.target });
        i = b.end;
        continue;
      }
    }
    if (ch === '[') {
      const b = bracketed(s, i);
      if (b) {
        flush();
        out.push({ t: 'a', href: b.target, c: parseInline(b.text) });
        i = b.end;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const end = s.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || !/\w/.test(s[i - 1]!)))) {
      let end = i + 1;
      while ((end = s.indexOf(ch, end)) > 0 && (s[end + 1] === ch || (ch === '_' && /\w/.test(s[end + 1] ?? '')))) end += 2;
      if (end > i + 1 && s[i + 1] !== ' ') {
        flush();
        out.push({ t: 'i', c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(text) || text.endsWith('\\')) {
        text = text.replace(/( {2,}|\\)$/, '');
        flush();
        out.push({ t: 'br' });
      } else text += ' ';
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// Blocks -------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line);

export function parseMarkdown(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'h', level: heading[1]!.length, c: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!)))
        body.push(QUOTE.exec(lines[i]!)?.[1] ?? lines[i]!);
      out.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      i += body.length;
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const itemRe = isOrdered ? ORDERED : BULLET;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = itemRe.exec(l);
        if (m && m[1]!.length <= 3) {
          items.push([m[3]!]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless an indented line follows.
          if (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1]!)) {
            items.at(-1)!.push('');
            i++;
            continue;
          }
          break;
        }
        if (/^ {2,}\S/.test(l)) {
          items.at(-1)!.push(l.replace(/^ {2,4}/, ''));
          i++;
          continue;
        }
        if (startsBlock(l)) break;
        items.at(-1)!.push(l.trim());
        i++;
      }
      out.push({ t: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered![2]) : 1, items: items.map((body) => parseMarkdown(body.join('\n'))) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        const row = cells(lines[i++]!);
        rows.push(head.map((_, k) => parseInline(row[k] ?? '')));
      }
      out.push({ t: 'table', align: head.map((_, k) => align[k] ?? ''), head: head.map(parseInline), rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) {
      if (para.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i]!)) break;
      para.push(lines[i++]!.replace(/^ +/, ''));
    }
    if (para.length === 0) {
      out.push({ t: 'p', c: parseInline(line.trim()) });
      i++;
      continue;
    }
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}
