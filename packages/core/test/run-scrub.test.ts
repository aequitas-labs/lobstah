import { describe, expect, it } from 'vitest';
import { OutputScrubber, scrubForms } from '../src/index.js';

const SECRET = 'p@ss/word+=?&"x';

/** Feed `text` to a scrubber in chunks cut at `cuts`, and return everything it emitted. */
function scrubIn(text: string, cuts: number[], values = [{ name: 'S', value: SECRET }]): { out: string; replaced: number } {
  const s = new OutputScrubber(values);
  let out = '';
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out += s.push(Buffer.from(text.slice(at, cut)));
    at = cut;
  }
  return { out: out + s.end(), replaced: s.replaced };
}

describe('the run output scrubber', () => {
  it('knows a value as printed, in base64, base64url, URL-encoded and JSON-escaped forms', () => {
    const forms = scrubForms([{ name: 'S', value: SECRET }]).map((f) => f.form);
    expect(forms).toEqual(
      expect.arrayContaining([SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64url'), encodeURIComponent(SECRET), JSON.stringify(SECRET).slice(1, -1)]),
    );
  });

  it('replaces a value wherever the stream is cut, including inside it', () => {
    const text = `start ${SECRET} middle ${encodeURIComponent(SECRET)} end\n`;
    for (let cut = 0; cut <= text.length; cut++) {
      const { out, replaced } = scrubIn(text, [cut]);
      expect(out, `cut at ${cut}`).toBe('start ‹S› middle ‹S› end\n');
      expect(replaced).toBe(2);
    }
  });

  it('replaces a value fed one byte at a time, and keeps a multi-byte character whole', () => {
    const text = `é ${SECRET} ✓\n`;
    const bytes = Buffer.from(text);
    const s = new OutputScrubber([{ name: 'S', value: SECRET }]);
    let out = '';
    for (const b of bytes) out += s.push(Buffer.from([b]));
    expect(out + s.end()).toBe('é ‹S› ✓\n');
  });

  it('passes text with no input values through unchanged, and holds nothing when there are none', () => {
    expect(scrubIn('plain output\n', [3, 7]).out).toBe('plain output\n');
    const none = new OutputScrubber([]);
    expect(none.push('right away')).toBe('right away');
  });

  it('replaces the longer of two values that overlap', () => {
    const { out } = scrubIn('token abc123456 and abc\n', [9], [{ name: 'SHORT', value: 'abc' }, { name: 'LONG', value: 'abc123456' }]);
    expect(out).toBe('token ‹LONG› and ‹SHORT›\n');
  });
});
