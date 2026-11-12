import { useMemo } from 'preact/hooks';
import { renderTerminal } from '../../../core/src/terminal-render.js';
import type { TerminalColor, TerminalSpan } from '../../../core/src/terminal-render.js';
import { html } from '../html.js';

/** A color as CSS: a palette index reads the theme's `--ansi-<n>`. */
const css = (c: TerminalColor): string => (c.startsWith('#') ? c : `var(--ansi-${c})`);

/** One styled run of text. A plain run is bare text. */
function span(s: TerminalSpan, key: number) {
  let { fg, bg } = s;
  if (s.inverse) [fg, bg] = [bg ?? 'inv-fg', fg ?? 'inv-bg'];
  const style = [fg && `color:${fg === 'inv-fg' ? 'var(--inset)' : css(fg)}`, bg && `background:${bg === 'inv-bg' ? 'var(--fg)' : css(bg)}`]
    .filter(Boolean)
    .join(';');
  const cls = [s.bold && 'tb', s.dim && 'td', s.italic && 'ti', s.underline && 'tu'].filter(Boolean).join(' ');
  if (!style && !cls) return s.text;
  return html`<span key=${key} class=${cls || undefined} style=${style || undefined}>${s.text}</span>`;
}

/**
 * Program output as a terminal would show it: carriage returns, erased
 * lines and cursor moves applied, colors kept as spans, and no escape
 * sequence shown. The raw stream stays in the run's output.log.
 */
export function TerminalOutput({ text }: { text: string }) {
  const lines = useMemo(() => renderTerminal(text), [text]);
  return lines.map((spans, i) => [i > 0 ? '\n' : '', ...spans.map((s, k) => span(s, k))]);
}
