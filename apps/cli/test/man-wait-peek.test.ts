import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout } from '@lobstah/core';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`):
// the bug was control flow in main.ts, so only a real invocation shows it.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-peek-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 10_000,
  });
  return { ...res, elapsedMs: Date.now() - started };
}

describe('man wait --peek — a check, never a park', () => {
  it('returns promptly with exit 0 and standing: none on an empty home', () => {
    const res = lobstah('man', 'wait', '--peek');
    expect(res.signal).toBeNull(); // not killed by the spawn timeout
    expect(res.status).toBe(0);
    expect(res.elapsedMs).toBeLessThan(5_000);
    expect(res.stdout).toContain('standing: none');
    expect(res.stdout).not.toContain('timeout');
  });

  it('emits a standing needs-decision without consuming it', () => {
    const id = '77777777-7777-7777-7777-777777777777';
    enqueue({ id, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(id, 'work', 'needs-decision', 'which flavor?');
    for (let i = 0; i < 2; i++) {
      const res = lobstah('man', 'wait', '--peek');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(id);
      expect(res.stdout).toContain('needs-decision');
      expect(res.stdout).not.toContain('standing: none');
    }
  });

  it('rejects --peek with --timeout as a usage error', () => {
    const res = lobstah('man', 'wait', '--peek', '--timeout', '3');
    expect(res.status).toBe(2);
    expect(res.stdout).toContain('--peek never blocks');
  });
});
