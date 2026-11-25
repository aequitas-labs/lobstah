import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

it('keeps normal chore waits quiet and exposes standing helm attention at the long-wait threshold', () => {
  const queuedAt: number = Date.parse('2026-11-24T12:02:00Z');
  enqueue({ id: 'holder', repo: 'web', brief: 'review' }, 'chore');
  claimNext('chore');
  appendStatus('holder', 'chore', 'working', 'reading the diff');
  fs.writeFileSync(path.join(laneDirs('chore').active, 'holder', 'runner.json'),
    JSON.stringify({ pid: process.pid, startedAt: '2026-11-24T12:00:00Z' }));
  enqueue({ id: 'waiting', repo: 'web', brief: 'review', queuedAt: new Date(queuedAt).toISOString() }, 'chore');

  // Stop reads dispatchProgress directly; tend uses the same standing attention.
  noticeDispatchProgress(Date.now());
  expect(dispatchProgress(Date.now())).toEqual([]);
  expect(listNotices()).toEqual([]);
  expect(buildTendReport(Date.now()).attention.filter((item) => item.kind === 'dispatch-progress')).toEqual([]);

  vi.setSystemTime(queuedAt + 1799_000);
  appendStatus('holder', 'chore', 'working', 'reviewing the next file');
  expect(dispatchProgress(Date.now())).toEqual([]);

  const thresholdAt: number = queuedAt + 1800_000;
  vi.setSystemTime(thresholdAt);
  noticeDispatchProgress(thresholdAt);
  expect(unseenNotices(true)).toHaveLength(1);
  // Consuming the wake leaves standing attention for Stop, without launching a CLI or waiting.
  const progress = dispatchProgress(thresholdAt);
  expect(progress).toHaveLength(1);
  expect(progress[0]?.text).toContain('holder (32m old)');
  expect(progress[0]?.text).toContain('Check or cancel the slot holder');
  expect(progress[0]?.text).not.toContain('re-address');
  const report = buildTendReport(thresholdAt);
  expect(report.attention.filter((item) => item.kind === 'dispatch-progress')).toHaveLength(1);
  expect(renderTend(report)).toContain('queued-too-long');
});
