import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, laneDirs } from '@lobstah/core';
import { watchQueues } from '../src/daemon.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-qwatch-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watchQueues', () => {
  it('fires on a queue write so an enqueue triggers a tick without waiting the interval', async () => {
    let fired = 0;
    const close = watchQueues(() => fired++);
    fs.writeFileSync(path.join(laneDirs('work').queue, 'aa.json'), '{}');
    const deadline = Date.now() + 3000;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    close();
    expect(fired).toBeGreaterThan(0);
  });

  it('close() detaches cleanly', () => {
    const close = watchQueues(() => {});
    expect(() => close()).not.toThrow();
  });
});
