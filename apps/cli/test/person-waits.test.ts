import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, parkQuestion } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { buildTendReport } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const id = 'aaaaaaaa-1111-4111-8111-111111111111';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-person-views-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  enqueue({ id, repo: 'r', brief: 'Work' }); claimNext('work');
  fs.writeFileSync(path.join(home, 'active', id, 'runner.json'), JSON.stringify({ pid: 999001, startedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }));
  appendStatus(id, 'work', 'needs-decision', 'Which option?', new Date(Date.now() - 86400_000).toISOString());
  parkQuestion(id, 'work', 86400);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('keeps the question visible in tend with its no-answer park reason and no occupied slot', () => {
  const report = buildTendReport();
  expect(report.parked).toContainEqual(expect.objectContaining({ id, note: 'parked: no answer in 24h' }));
  expect(report.attention).toContainEqual(expect.objectContaining({ id, kind: 'question', note: 'Which option?' }));
  expect(report.counts.headlessActive).toBe(0);
});

it('shows the parked question reason and person wait in glass while preserving the question verb', () => {
  const snapshot = buildGlassSnapshot();
  expect(snapshot.dispatches).toContainEqual(expect.objectContaining({ id, verb: 'needs-decision', note: 'parked: no answer in 24h · Which option?', waiting: expect.objectContaining({ on: 'person' }) }));
  expect(snapshot.slots).toMatchObject({ headless: 0, parked: 1 });
});
