import { describe, expect, it } from 'vitest';
import { parseReportArgs } from '../src/report-args.js';

describe('parseReportArgs', () => {
  it('keeps a quoted single-argument note when no --pr is present', () => {
    expect(parseReportArgs(['brief fulfilled, PR opened'])).toEqual({
      note: 'brief fulfilled, PR opened',
      prUrl: undefined,
    });
  });

  it('keeps every word of an unquoted note when no --pr is present', () => {
    expect(parseReportArgs(['tests', 'green,', 'pushing'])).toEqual({
      note: 'tests green, pushing',
      prUrl: undefined,
    });
  });

  it('extracts the --pr pair and keeps the surrounding note', () => {
    expect(parseReportArgs(['opened', '--pr', 'https://x/1', 'and', 'linked'])).toEqual({
      note: 'opened and linked',
      prUrl: 'https://x/1',
    });
  });

  it('handles --pr first and note after', () => {
    expect(parseReportArgs(['--pr', 'https://x/2', 'done'])).toEqual({ note: 'done', prUrl: 'https://x/2' });
  });

  it('empty rest is no note, no pr', () => {
    expect(parseReportArgs([])).toEqual({ note: undefined, prUrl: undefined });
  });
});
