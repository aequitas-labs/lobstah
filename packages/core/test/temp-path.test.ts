import { expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { uniqueTempPath } from '../src/paths.js';

it('temporary names are unique even for the same pid and millisecond, and stay beside the target', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
  try {
    const target = path.join('state', 'watch.json');
    const names = Array.from({ length: 1000 }, () => uniqueTempPath(target));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => path.dirname(name) === path.dirname(target))).toBe(true);
    expect(names.every((name) => name.startsWith(`${target}.tmp-`))).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
