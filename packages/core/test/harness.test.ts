import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexInvocation, lobstahVersion, onPath } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-harness-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('onPath', () => {
  it('finds an executable file on the given PATH and misses a plain file', () => {
    fs.writeFileSync(path.join(dir, 'mytool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'notexec'), '');
    expect(onPath('mytool', dir)).toBe(true);
    expect(onPath('missing', dir)).toBe(false);
    if (process.platform !== 'win32') expect(onPath('notexec', dir)).toBe(false);
  });

  it('is false with no PATH at all', () => {
    expect(onPath('anything', undefined)).toBe(false);
  });
});

describe('codexInvocation', () => {
  it('resolves to something runnable in this workspace (SDK dep is installed)', () => {
    const inv = codexInvocation(['resume', 'abc']);
    expect(inv).toBeDefined();
    expect(inv!.argv.slice(-2)).toEqual(['resume', 'abc']);
  });
});

describe('lobstahVersion', () => {
  it('reports the dev placeholder when not running from the published layout', () => {
    expect(lobstahVersion()).toMatch(/^\d+\.\d+\.\d+(-dev)?$/);
  });
});
