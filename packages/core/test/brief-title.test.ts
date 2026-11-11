import { describe, expect, it } from 'vitest';
import { briefFirstLine } from '../src/brief-title.js';

describe('briefFirstLine', () => {
  it('drops a leading heading marker and its space', () => {
    expect(briefFirstLine('# homebase #2813: keep the book button\n\nbody')).toBe('homebase #2813: keep the book button');
    expect(briefFirstLine('## Retry failed uploads\nbody')).toBe('Retry failed uploads');
    expect(briefFirstLine('  ###### deep  ')).toBe('deep');
  });

  it('keeps a # with no space after it, and one later in the line', () => {
    expect(briefFirstLine('#2813 needs a second look')).toBe('#2813 needs a second look');
    expect(briefFirstLine('Fix issue #12 in the tray')).toBe('Fix issue #12 in the tray');
  });

  it('leaves plain text as it is, trimmed, first line only', () => {
    expect(briefFirstLine('  Plain title  \r\nsecond line')).toBe('Plain title');
    expect(briefFirstLine('')).toBe('');
  });
});
