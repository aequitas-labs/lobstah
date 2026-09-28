import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, mergeEvidence, writeActivity } from '@lobstah/core';
import { liveStatus } from '../src/live-status.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-live-comment-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

it('renders a safe mid-run status comment with activity age and remote evidence', () => {
  const id = '44444444-4444-4444-4444-444444444444';
  const now = Date.parse('2026-09-28T20:00:00.000Z');
  enqueue({ id, repo: 'demo', brief: 'work' }, 'work');
  claimNext('work');
  appendStatus(id, 'work', 'working');
  writeActivity(id, 'work', { at: new Date(now - 12_000).toISOString(), kind: 'tool', summary: 'editing src/run.ts' });
  mergeEvidence(id, 'work', { branch: 'lobstah/demo', commits: ['abc123 add progress'],
    prUrl: 'https://github.com/example/repo/pull/7' });
  const { body } = liveStatus(id, 'work', 'working', new Date(now - 120_000).toISOString(), now);
  expect(body).toContain('**working**');
  expect(body).toContain('activity: editing src/run.ts 12s ago');
  expect(body).toContain('elapsed: 2m (attempt 1)');
  expect(body).toContain('branch: `lobstah/demo`');
  expect(body).toContain('last commit: abc123 add progress');
  expect(body).toContain('draft PR: https://github.com/example/repo/pull/7');
  expect(body).toContain('updated 2026-09-28T20:00:00.000Z');
});
