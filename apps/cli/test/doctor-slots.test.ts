import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimNext, enqueue, ensureLayout, laneDirs } from '@lobstah/core';
import { runDoctor } from '../src/doctor.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-doctor-slots-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nmaxConcurrent = 2\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

it('adds slot usage to the existing daemon row without adding a new row', async () => {
  enqueue({ id: 'headless', repo: 'r', brief: 'b' });
  claimNext('work');
  enqueue({ id: 'trap', repo: 'r', brief: 'b' });
  claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, 'trap', 'claim.json'), JSON.stringify({ by: 'wt:trap1' }));
  const rows = await runDoctor();
  expect(rows.filter((r) => r.check === 'daemon')).toHaveLength(1);
  expect(rows.find((r) => r.check === 'daemon')?.detail).toContain('headless: 1 of 2 work, 0 of 1 chore; traps: 1');
});
