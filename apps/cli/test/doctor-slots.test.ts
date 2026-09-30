import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimNext, enqueue, ensureLayout, laneDirs } from '@lobstah/core';
import { runDoctor } from '../src/doctor.js';
import { stampRepairerBeat } from '../src/pr-repair.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-doctor-slots-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nmaxConcurrent = 2\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
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

it('reports the repairer process and warns when its heartbeat is absent', async () => {
  expect((await runDoctor()).find((r) => r.check === 'PR repairer')).toMatchObject({ status: 'warn', detail: 'no repairer is running' });
  stampRepairerBeat();
  expect((await runDoctor()).find((r) => r.check === 'PR repairer')).toMatchObject({ status: 'ok' });
  expect((await runDoctor()).find((r) => r.check === 'PR repairer')?.detail).toContain(`daemon pid ${process.pid}`);
});
