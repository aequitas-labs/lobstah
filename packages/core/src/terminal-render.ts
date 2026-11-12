/**
 * What a terminal would show for a stream of program output: carriage
 * returns, erase-line, and cursor moves apply, so a spinner or an answered
 * prompt collapses to its final text, and SGR colors become styled spans.
 * Every other escape sequence is dropped. The screen has no width, so long
 * lines don't wrap, and scrollback is kept: a clear-screen starts a new
 * screen below what came before.
 *
 * Pure and dependency-free: the CLI and the glass page (local and hosted)
 * both import it.
 */

/** A color: an ANSI palette index (`0`–`15`) or `#rrggbb`. */
export type TerminalColor = string;

/** A run of text in one style. */
export interface TerminalSpan {
  text: string;
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  /** Foreground and background swapped, where a color is the default. */
  inverse?: true;
}

type Style = Omit<TerminalSpan, 'text'>;
interface Cell {
  ch: string;
  style: Style;
}

const PLAIN: Style = Object.freeze({});
/** A code point that joins the cell before it: combining marks, variation selectors, the zero-width joiner, a keycap. */
const JOINS = /^[̀-ͯ᪰-᫿⃐-⃿︀-️‍\u{e0020}-\u{e007f}\u{1f3fb}-\u{1f3ff}]$/u;

/** One of the 256 xterm colors past the first 16, as `#rrggbb`. */
function color256(n: number): TerminalColor {
  if (n < 16) return String(n);
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const i = n - 16;
  const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
}

/** Apply one SGR (`ESC[…m`) parameter list to a style. */
function sgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  let s: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.inverse = true;
    else if (c === 22) {
      delete s.bold;
      delete s.dim;
    } else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c === 27) delete s.inverse;
    else if (c >= 30 && c <= 37) s.fg = String(c - 30);
    else if (c >= 90 && c <= 97) s.fg = String(c - 90 + 8);
    else if (c === 39) delete s.fg;
    else if (c >= 40 && c <= 47) s.bg = String(c - 40);
    else if (c >= 100 && c <= 107) s.bg = String(c - 100 + 8);
    else if (c === 49) delete s.bg;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        s[key] = color256(codes[i + 2]! & 255);
        i += 2;
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        const hex = (v: number) => (v & 255).toString(16).padStart(2, '0');
        s[key] = `#${hex(codes[i + 2]!)}${hex(codes[i + 3]!)}${hex(codes[i + 4]!)}`;
        i += 4;
      } else break;
    }
  }
  return s;
}

const sameStyle = (a: Style, b: Style): boolean =>
  a === b ||
  (a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse);

/** The screen the stream draws: lines of cells, styled. */
export function renderTerminal(raw: string): TerminalSpan[][] {
  const lines: Cell[][] = [[]];
  let row = 0,
    col = 0,
    style: Style = PLAIN,
    saved = { row: 0, col: 0 },
    top = 0;
  const line = (r: number): Cell[] => {
    while (lines.length <= r) lines.push([]);
    return lines[r]!;
  };
  const put = (ch: string) => {
    const l = line(row);
    while (l.length < col) l.push({ ch: ' ', style: PLAIN });
    l[col] = { ch, style };
    col++;
  };
  const cps = Array.from(raw);
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    if (ch === '\x1b') {
      const next = cps[i + 1];
      if (next === undefined) break;
      if (next === '[') {
        // CSI: parameter bytes, intermediate bytes, one final byte.
        let j = i + 2;
        let params = '';
        while (j < cps.length && /[0-?]/.test(cps[j]!)) params += cps[j++];
        while (j < cps.length && /[ -/]/.test(cps[j]!)) j++;
        const final = cps[j];
        if (final === undefined) break;
        i = j;
        if (params.startsWith('?') || params.startsWith('>') || params.startsWith('<') || params.startsWith('=')) continue;
        const nums = params.split(';').map((p) => (p === '' ? undefined : Number(p)));
        const n = (k = 0, d = 1) => {
          const v = nums[k];
          return v === undefined || !Number.isFinite(v) || v < 1 ? d : v;
        };
        switch (final) {
          case 'm':
            style = sgr(style, params);
            break;
          case 'A':
            row = Math.max(top, row - n());
            break;
          case 'B':
            row += n();
            break;
          case 'C':
            col += n();
            break;
          case 'D':
            col = Math.max(0, col - n());
            break;
          case 'E':
            row += n();
            col = 0;
            break;
          case 'F':
            row = Math.max(top, row - n());
            col = 0;
            break;
          case 'G':
          case '`':
            col = n() - 1;
            break;
          case 'd':
            row = top + n() - 1;
            break;
          case 'H':
          case 'f':
            row = top + n(0) - 1;
            col = n(1) - 1;
            break;
          case 'K': {
            const l = line(row);
            const mode = nums[0] ?? 0;
            if (mode === 0) l.length = Math.min(l.length, col);
            else if (mode === 1) for (let k = 0; k <= col && k < l.length; k++) l[k] = { ch: ' ', style: PLAIN };
            else if (mode === 2) l.length = 0;
            break;
          }
          case 'J': {
            const mode = nums[0] ?? 0;
            if (mode === 0) {
              line(row).length = Math.min(line(row).length, col);
              lines.length = row + 1;
            } else if (mode === 2 || mode === 3) {
              // A new screen below the old one, so nothing scrolls away.
              while (lines.length && lines[lines.length - 1]!.length === 0) lines.pop();
              top = lines.length;
              row = top;
              col = 0;
            }
            break;
          }
          case 's':
            saved = { row, col };
            break;
          case 'u':
            ({ row, col } = saved);
            break;
          default:
          // Scroll regions, tab stops, modes and reports draw nothing.
        }
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC, DCS and friends: a string ended by BEL or ESC \. A hyperlink's text sits outside it and stays.
        let j = i + 2;
        while (j < cps.length && cps[j] !== '\x07' && !(cps[j] === '\x1b' && cps[j + 1] === '\\')) j++;
        if (j >= cps.length) break;
        i = cps[j] === '\x07' ? j : j + 1;
        continue;
      }
      if (next === '7') saved = { row, col };
      else if (next === '8') ({ row, col } = saved);
      else if (next === 'M') row = Math.max(top, row - 1);
      else if (next === 'D' || next === 'E') {
        row++;
        if (next === 'E') col = 0;
      } else if (next === 'c') style = PLAIN;
      else if ('()*+-./#%'.includes(next)) i++; // A charset designation takes one more byte.
      i++;
      continue;
    }
    if (ch === '\r') col = 0;
    else if (ch === '\n') {
      // Pipes carry a bare newline; a terminal's line discipline adds the return.
      row++;
      col = 0;
    } else if (ch === '\b') col = Math.max(0, col - 1);
    else if (ch === '\t') {
      const to = (Math.floor(col / 8) + 1) * 8;
      while (col < to) put(' ');
    } else if (ch < ' ' || ch === '\x7f' || (ch >= '\x80' && ch <= '\x9f')) {
      // Other control characters (BEL, shift codes, 8-bit controls) draw nothing.
    } else if (JOINS.test(ch) || (col > 0 && line(row)[col - 1]?.ch.endsWith('‍'))) {
      const prev = line(row)[col - 1];
      if (prev) prev.ch += ch;
      else put(ch);
    } else put(ch);
  }
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines.map((cells) => {
    let end = cells.length;
    while (end > 0 && cells[end - 1]!.ch === ' ' && !cells[end - 1]!.style.bg && !cells[end - 1]!.style.inverse) end--;
    const spans: TerminalSpan[] = [];
    for (let k = 0; k < end; k++) {
      const { ch, style: s } = cells[k]!;
      const last = spans[spans.length - 1];
      if (last && sameStyle(last, s)) last.text += ch;
      else spans.push({ text: ch, ...s });
    }
    return spans;
  });
}

/** The same screen as plain text: what the helm reads. */
export function terminalText(raw: string): string {
  return renderTerminal(raw)
    .map((spans) => spans.map((s) => s.text).join(''))
    .join('\n');
}
