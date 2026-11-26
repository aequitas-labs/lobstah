import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, dispatchProgress, enqueue, ensureLayout, laneDirs, listNotices,
  noticeDispatchProgress, unseenNotices } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-chore-attention-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-24T12:05:00Z'));
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.web]\npath = "/unused"\n');
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('shows running chore turns without attention even after the former long-wait threshold', () => {
  enqueue({ id: 'holder', repo: 'web', brief: 'review' }, 'chore');
  claimNext('chore');
  appendStatus('holder', 'chore', 'working', 'reading the diff');
  fs.writeFileSync(path.join(laneDirs('chore').active, 'holder', 'runner.json'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  for (const [index, id] of ['first', 'second', 'third', 'waiting'].entries()) {
    enqueue({ id, repo: 'web', brief: 'review' }, 'chore');
    const queued = new Date(Date.now() + index);
    fs.utimesSync(path.join(laneDirs('chore').queue, `${id}.json`), queued, queued);
  }
  vi.setSystemTime(Date.now() + 3600_000);
  appendStatus('holder', 'chore', 'working', 'reviewing the next file');
  noticeDispatchProgress();
  expect(dispatchProgress()).toEqual([]);
  expect(listNotices()).toEqual([]);
  expect(unseenNotices(true)).toEqual([]);
  const report = buildTendReport();
  expect(report.attention.filter((item) => item.kind === 'dispatch-progress')).toEqual([]);
  expect(report.queuedChores?.find((item) => item.id === 'waiting')?.reason).toBe('queued behind 1 running chore (3 ahead)');
  expect(renderTend(report)).toContain('queued behind 1 running chore (3 ahead)');
  expect(renderTend(report)).not.toContain('queued-too-long');

  const cli: string = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  for (const args of [['status', 'waiting'], ['status']]) {
    const status = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env, timeout: 20_000 });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('queued behind 1 running chore (3 ahead)');
    expect(status.stdout).not.toContain('queued-too-long');
  }
});
