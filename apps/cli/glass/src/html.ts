/**
 * A tiny tagged template for the page's markup. Every interpolated value is
 * escaped (& < > ") unless it is already Html — a nested html`` fragment or
 * raw() — so markup composes and data never becomes markup by accident.
 * Arrays join with no separator; null, undefined, and false render nothing.
 */

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape text for an element body or a double-quoted attribute. */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]!);

/** Trusted markup, inserted as-is. */
export const raw = (s: string): Html => new Html(s);

export type Part = Html | string | number | boolean | null | undefined | readonly Part[];

function part(v: Part): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]!) + strings[i + 1]!;
  return new Html(out);
}

/** Join fragments with a separator (the separator is trusted markup). */
export const join = (items: readonly Part[], sep = ''): Html => raw(items.map(part).join(sep));
