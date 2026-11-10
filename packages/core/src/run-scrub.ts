import { StringDecoder } from 'node:string_decoder';

/**
 * The run card's output scrubber (ume 3ef69c1d-026, intent run-execute).
 * Every byte a run prints passes through it before it leaves the glass
 * process. Each input value, and its base64, base64url, URL-encoded and
 * JSON-escaped forms, is replaced with `‹NAME›`. It holds back the longest
 * form's length less one character, so a value split across two chunks is
 * still caught when the next chunk lands. A secret the script transforms
 * (hashes, slices, re-encodes otherwise) is not caught; the card says so.
 */

/** One value to scrub, and the name that replaces it. */
export interface ScrubValue {
  name: string;
  value: string;
}

/** The forms a value may be printed in, each mapped to its replacement. */
export function scrubForms(values: readonly ScrubValue[]): Array<{ form: string; mark: string }> {
  const out = new Map<string, string>();
  for (const { name, value } of values) {
    if (!value) continue;
    const mark = `‹${name}›`;
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    for (const form of [value, base64, base64.replace(/=+$/, ''), Buffer.from(value, 'utf8').toString('base64url'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
      // A longer value's mark wins where two forms are the same text.
      if (form && (!out.has(form) || out.get(form)!.length < mark.length)) out.set(form, mark);
    }
  }
  // Longest first: a form that contains another is replaced whole.
  return [...out].map(([form, mark]) => ({ form, mark })).sort((a, b) => b.form.length - a.form.length);
}

/** A streaming scrubber for one output stream. */
export class OutputScrubber {
  private forms: Array<{ form: string; mark: string }>;
  private hold: number;
  private readonly values: ScrubValue[];
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  /** How many values it replaced so far. */
  replaced = 0;

  constructor(values: readonly ScrubValue[]) {
    this.values = [...values];
    this.forms = scrubForms(this.values);
    this.hold = Math.max(0, ...this.forms.map((f) => f.form.length - 1));
  }

  /** Scrub one more value from here on: a secret line typed into a running console. */
  add(value: ScrubValue): void {
    this.values.push(value);
    this.forms = scrubForms(this.values);
    this.hold = Math.max(0, ...this.forms.map((f) => f.form.length - 1));
  }

  /** Scrub a chunk; returns the text now safe to show (some may be held back for the next chunk). */
  push(chunk: Buffer | string): string {
    return this.scrub(this.pending + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk)), false);
  }

  /** The rest, at the end of the stream. */
  end(): string {
    return this.scrub(this.pending + this.decoder.end(), true);
  }

  private scrub(text: string, final: boolean): string {
    // No match can start before `safe` and run past the end of `text`: each form is at most hold+1 long.
    const safe = final ? text.length : Math.max(0, text.length - this.hold);
    let out = '';
    let at = 0;
    for (;;) {
      let hit: { index: number; form: string; mark: string } | undefined;
      for (const f of this.forms) {
        const index = text.indexOf(f.form, at);
        if (index !== -1 && (!hit || index < hit.index)) hit = { index, ...f };
      }
      if (!hit || hit.index >= safe) break;
      out += text.slice(at, hit.index) + hit.mark;
      at = hit.index + hit.form.length;
      this.replaced += 1;
    }
    const emitEnd = Math.max(at, safe);
    out += text.slice(at, emitEnd);
    this.pending = text.slice(emitEnd);
    return out;
  }
}
