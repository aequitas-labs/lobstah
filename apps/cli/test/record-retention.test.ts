import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  answerDecision, askDecision, decisionDir, ensureLayout, fileReport, newHelmReportKey,
  prepareRunCard, writeRunAttempt, readRunAttempt,
  prRecordFile, readRecordArchive, releaseFile, requestsDir, requestFilesDir, withdrawDecision, archivedDecisionDir,
} from '@lobstah/core';
import { applyCull, planCull } from '../src/cull.js';
import { writeAck, readAck } from '../src/acks.js';
import { createRunCleanup } from '../src/run-cleanup.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const DAY = 86_400_000;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-record-retention-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('keeps answered cards, reports, closed PRs, orphaned acks and releases thirty days, then archives every removed file', () => {
  const now = Date.now();
  const { meta } = askDecision({ title: 'Keep the answer', askedBy: 'helm', options: ['Yes'], maxBytes: 1024 });
  const attachment = path.join(home, 'answer.txt');
  fs.writeFileSync(attachment, 'Answer attachment');
  const answer = answerDecision({ key: meta.key, option: 'Yes', by: 'glass', attach: [attachment], maxBytes: 1024 });
  const standing = askDecision({ title: 'Still waiting', askedBy: 'helm', options: ['Yes'], maxBytes: 1024 }).meta.key;
  const reportFile = path.join(home, 'report.md');
  fs.writeFileSync(reportFile, '# Keep the findings');
  const report = fileReport({ key: newHelmReportKey('home'), file: reportFile, fallbackTitle: 'Findings', author: 'helm', maxBytes: 1024 });
  const key = 'pr:o/r#7';
  fs.mkdirSync(path.dirname(prRecordFile(key)), { recursive: true });
  fs.writeFileSync(prRecordFile(key), JSON.stringify({ key, url: 'https://github.com/o/r/pull/7', state: 'MERGED', observedAt: new Date(now).toISOString(), dispatches: [] }));
  const ackKey = 'work:removed';
  writeAck({ key: ackKey, kind: 'landed', stateHash: 'a', at: new Date(now).toISOString(), by: 'glass' });
  fs.mkdirSync(path.dirname(releaseFile(ackKey)), { recursive: true });
  fs.writeFileSync(releaseFile(ackKey), JSON.stringify({ key: ackKey, stateHash: 'a', releasedAt: new Date(now).toISOString(), by: 'helm' }));

  expect(planCull(1, now + 2 * DAY, { measure: false })).toEqual([]);
  const plan = planCull(1, now + 31 * DAY, { measure: false });
  expect(plan.map((item) => item.kind).sort()).toEqual(['ack', 'decision', 'pr', 'release', 'report']);
  applyCull(plan);
  expect(fs.existsSync(decisionDir(meta.key)!)).toBe(false);
  expect(fs.existsSync(decisionDir(standing)!)).toBe(true);
  expect(readAck(ackKey)).toBeUndefined();
  const receipt = readRecordArchive(meta.key)!;
  for (const key of [report.key, 'pr:o/r#7', ackKey]) expect(readRecordArchive(key)?.bundle).toBe(receipt.bundle);
  const staging = path.join(home, 'restore');
  fs.mkdirSync(staging);
  execFileSync('tar', ['-xzf', path.join(home, 'archive', receipt.bundle), '-C', staging]);
  expect(fs.readFileSync(path.join(staging, path.relative(home, requestFilesDir(answer.request)), 'answer.txt'), 'utf8')).toBe('Answer attachment');
  expect(fs.existsSync(path.join(staging, path.relative(home, requestsDir()), `${answer.request}.json`))).toBe(true);
  expect(fs.existsSync(path.join(staging, path.relative(home, releaseFile(ackKey))))).toBe(true);
});

it('archives withdrawn non-run cards using the record window', () => {
  const key = askDecision({ title: 'Withdrawn', askedBy: 'helm', options: ['Yes'], maxBytes: 100 }).meta.key;
  withdrawDecision(key);
  const dir = archivedDecisionDir(key)!;
  const now = Date.now();
  expect(planCull(1, now + 2 * DAY)).toEqual([]);
  applyCull(planCull(1, now + 31 * DAY));
  expect(fs.existsSync(dir)).toBe(false);
  expect(readRecordArchive(key)).toBeDefined();
});

it('keeps recent orphan acks and releases when record retention is disabled', () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nrecordRetentionDays = 0\n');
  writeAck({ key: 'work:gone', kind: 'landed', stateHash: 'x', at: '2020-01-01T00:00:00Z', by: 'glass' });
  expect(planCull(1)).toEqual([]);
});


it('uses recordRetentionDays for run cleanup even when the legacy run window is one day', () => {
  const now = Date.now();
  fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nrunRetentionDays = 1\n');
  const script = path.join(home, 'script.sh');
  fs.writeFileSync(script, 'echo ok');
  const run = prepareRunCard({ scriptFile: script, cwd: home });
  const key = askDecision({ title: 'Keep output', askedBy: 'helm', options: ['Decline'], run, maxBytes: 1024 }).meta.key;
  writeRunAttempt({ id: '11111111-1111-4111-8111-111111111111', key, scriptSha256: run.card.scriptSha256,
    state: 'succeeded', startedAt: new Date(now - 2 * DAY - 1000).toISOString(), finishedAt: new Date(now - 2 * DAY).toISOString() }, 'keep output');
  const cleanup = createRunCleanup();
  cleanup(now, () => {});
  expect(readRunAttempt(key)?.state).toBe('succeeded');
  expect(readRecordArchive(key)).toBeUndefined();
  cleanup(now + 31 * DAY, () => {});
  expect(readRunAttempt(key)).toBeUndefined();
  expect(readRecordArchive(key)).toBeDefined();
});
