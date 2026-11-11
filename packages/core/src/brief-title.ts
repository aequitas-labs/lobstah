/**
 * A brief's first line as a title, the one place the glasses derive it:
 * trimmed, without a leading Markdown heading marker (`#` to `######` and the
 * space after it), which only clutters a row. A `#` later in the line, or one
 * with no space after it (`#2813`), stays. Free of Node imports, so the hosted
 * glass's page bundles it too.
 */
export function briefFirstLine(brief: string): string {
  return (brief.split(/\r?\n/, 1)[0] ?? '').trim().replace(/^#{1,6}\s+/, '').trim();
}
