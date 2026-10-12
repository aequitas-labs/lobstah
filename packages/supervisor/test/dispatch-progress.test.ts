import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueue, ensureLayout, claimNext, appendStatus, listNotices, laneDirs } from '@lobstah/core';
import { tick } from '../src/daemon.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-progress-tick-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nmaxConcurrent = 0\n');
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });
it('the daemon wakes queued and stalled work, not paused work, once per backoff interval', () => {
  enqueue({ id: 'silent', repo: 'r', brief: 'b' }); claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, 'silent', 'claim.json'), JSON.stringify({ by: 'wt:seat', at: new Date().toISOString() }));
  appendStatus('silent', 'work', 'working', 'old note');
  enqueue({ id: 'queued', repo: 'r', brief: 'b', for: 'wt:missing' });
  vi.setSystemTime(Date.now() + 1200_000);
  tick(); tick();
  expect(listNotices().filter((n) => n.kind === 'dispatch-progress').map((n) => n.refId).sort()).toEqual(['queued', 'silent']);
  appendStatus('silent', 'work', 'paused', 'waiting');
  vi.setSystemTime(Date.now() + 900_000); tick();
  expect(listNotices().filter((n) => n.kind === 'dispatch-progress' && n.refId === 'silent')).toHaveLength(1);
});
