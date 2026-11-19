import { restoreCommandWatch } from '../src/watch-command-runtime.js';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addWatch,
  builtinWatchRegistry,
  derivePrEvents,
  ensureLayout,
  listNotices,
  parsePrRef,
  prEvidence,
  prStandingKinds,
  prStateHash,
  readWatch,
  readWatchEvents,
  runWatchCheck,
  runWatchCycle,
  upsertPr,
  WatchJournal,
} from '../src/index.js';
import type { GhPrView } from '../src/pr.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const reference = parsePrRef('https://github.com/acme/web/pull/7')!;
const view = (conclusion: string, head = 'head-1'): GhPrView => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: head,
  baseRefName: 'main',
  headRefName: 'feature',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion }],
  reviews: [],
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-source-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'schemaVersion=2\n[watchTypes.pr]\nreadySettleSecs=0\n');
});
afterEach(() => {
  vi.useRealTimers();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('imports legacy PR registrations into a typed journal without resetting cursor or ownership', () => {
  const watch = addWatch(reference.key, 'lobstah watch check-pr pr:acme/web#7 --cursor {cursor}', {
    cursor: 'existing-checkpoint',
    owner: 'dispatch:owner',
  });
  expect(watch.typeId).toBe('pr');
  restoreCommandWatch(watch);
  const snapshot = new WatchJournal().read(reference.key)!;
  expect(snapshot).toMatchObject({
    type: { id: 'pr' },
    reference,
    cursor: 'existing-checkpoint',
    owner: { kind: 'dispatch', chainId: 'owner' },
  });
  restoreCommandWatch(addWatch(reference.key, watch.check, { owner: 'dispatch:owner' }));
  expect(new WatchJournal().read(reference.key)?.generation).toBe(snapshot.generation);
});

it('retains legacy event IDs, checkpoints, attention hashes and terminal behavior through a PR history', () => {
  const script = path.join(home, 'check.cjs'),
    output = path.join(home, 'result.json');
  fs.writeFileSync(script, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(output)}, 'utf8'))`);
  addWatch(reference.key, `"${process.execPath}" "${script}" watch check-pr --cursor {cursor}`, { owner: 'dispatch:owner' });
  let cursor = '0';
  const expectedIds: string[] = [];
  for (const [index, observation] of [
    view('SUCCESS'),
    view('FAILURE'),
    view('FAILURE', 'head-2'),
    { ...view('SUCCESS', 'head-2'), state: 'MERGED' },
  ].entries()) {
    const now = new Date(Date.now() + index * 60_000);
    const record = upsertPr(prEvidence(reference, observation, now.toISOString())).after;
    const expected = derivePrEvents(reference, observation, cursor);
    const events = expected.events.filter((event) => !event.notice);
    expectedIds.push(...events.map((event) => event.seq));
    fs.writeFileSync(output, JSON.stringify({ cursor: expected.cursor, events, done: expected.done }));
    const result = runWatchCheck(readWatch(reference.key)!, now);
    cursor = expected.cursor;
    const journal = new WatchJournal().read(reference.key)!;
    expect(result.watch.cursor).toBe(cursor);
    expect(journal.events.map((event) => event.id)).toEqual(expectedIds);
    expect(readWatchEvents(reference.key).map((event) => event.seq)).toEqual(expectedIds);
    expect(journal.presentation.helm.read?.args).toEqual(['prs']);
    expect(journal.presentation.attention.map((condition) => condition.kind)).toEqual(prStandingKinds(record));
    expect(journal.presentation.attention.every((condition) => condition.stateHash === prStateHash(record))).toBe(true);
    expect(result.watch.done === true).toBe(expected.done);
  }
  expect(expectedIds).toHaveLength(2);
  expect(new Set(expectedIds).size).toBe(2);
});

it('batches a shared GitHub rate limit once and retains every PR checkpoint without per-watch streaks', () => {
  const now = Date.now();
  for (const number of [7, 8]) addWatch(`pr:acme/web#${number}`, `lobstah watch check-pr pr:acme/web#${number}`, { cursor: 'before' });
  const run = vi.fn(() => ({
    status: 1,
    stdout: 'HTTP/2 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nretry-after: 60\r\n\r\n{"message":"API rate limit exceeded"}',
  }));
  const results = runWatchCycle(45, new Date(now), { registry: builtinWatchRegistry({ run }) });
  expect(run).toHaveBeenCalledTimes(1);
  expect(results).toHaveLength(2);
  for (const { watch, fresh } of results) {
    expect(watch.cursor).toBe('before');
    expect(watch.failures).toBeUndefined();
    expect(fresh).toEqual([]);
    expect(new WatchJournal().read(watch.key)).toMatchObject({ cursor: 'before', failures: 0, events: [] });
  }
  expect(listNotices().filter((notice) => notice.kind === 'rate-limited')).toHaveLength(1);
});

it('source-declared import preserves an existing command cursor, buffered observations and reserved delivery ID', () => {
  const watch = addWatch(reference.key, 'lobstah watch check-pr pr:acme/web#7 --cursor {cursor}');
  restoreCommandWatch(watch);
  const journal = new WatchJournal();
  journal.update(reference.key, (snapshot) => {
    if (!snapshot) throw new Error('missing fixture');
    snapshot.type = { id: 'command', apiVersion: 1, stateVersion: 1, version: '1.0.0' };
    snapshot.reference = { key: reference.key };
    snapshot.cursor = 'prior-checkpoint';
    snapshot.events = [{ id: 'prior-event', kind: 'check-completed', at: snapshot.createdAt, summary: 'verify failed', data: {} }];
    snapshot.deliveries = [{ id: 'receipt', eventIds: ['prior-event'], status: 'pending', continuationId: 'reserved-worker' }];
    return { snapshot, result: undefined };
  });
  restoreCommandWatch(watch);
  expect(journal.read(reference.key)).toMatchObject({
    type: { id: 'pr' },
    cursor: 'prior-checkpoint',
    reference,
    events: [{ id: 'prior-event' }],
    deliveries: [{ id: 'receipt', status: 'pending', continuationId: 'reserved-worker' }],
  });
});

it('adapter grouping retains the shared budget allocation across repositories', () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const script = path.join(home, 'quiet.cjs');
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({cursor:'0',events:[]}))`);
  for (const repo of ['web', 'api']) addWatch(`pr:acme/${repo}#7`, `"${process.execPath}" "${script}" watch check-pr pr:acme/${repo}#7`);
  const run = vi.fn(() => ({
    status: 0,
    stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 100\r\nX-Ratelimit-Reset: ${(now + 3600_000) / 1000}\r\n\r\n${JSON.stringify({ data: { repository: {}, rateLimit: { cost: 5 } } })}`,
  }));
  runWatchCycle(45, new Date(now), { registry: builtinWatchRegistry({ run }) });
  expect(run).toHaveBeenCalledTimes(2);
  for (const repo of ['web', 'api']) {
    const cycle = JSON.parse(fs.readFileSync(path.join(home, 'pr-polls', `acme_${repo}.json`), 'utf8'));
    expect(cycle.nextAt).toBe(now + 720_000);
  }
});

it('a replacement legacy generation starts fresh rather than importing the removed source’s receipts', () => {
  const watch = addWatch(reference.key, 'lobstah watch check-pr pr:acme/web#7 --cursor {cursor}');
  restoreCommandWatch(watch);
  const journal = new WatchJournal();
  journal.update(reference.key, (snapshot) => {
    if (!snapshot) throw new Error('missing fixture');
    snapshot.type = { id: 'command', apiVersion: 1, stateVersion: 1, version: '1.0.0' };
    snapshot.reference = { key: reference.key };
    snapshot.originGeneration = 'removed-generation';
    snapshot.cursor = 'removed-checkpoint';
    snapshot.deliveries = [{ id: 'old', eventIds: ['removed-event'], status: 'pending' }];
    return { snapshot, result: undefined };
  });
  restoreCommandWatch(watch);
  expect(journal.read(reference.key)).toMatchObject({
    type: { id: 'pr' },
    cursor: '0',
    deliveries: [],
    originGeneration: watch.generation,
  });
});
