import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  enqueue,
  ensureLayout,
  listNotices,
  listWatches,
  parsePrRef,
  readPr,
  readPrs,
  readWatch,
  readWatchEvents,
  runWatchCheck,
  repairKind,
  upsertPr,
  prEvidence,
} from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { addPrWatch, syncPrWatches } from '../src/pr-watch.js';
import { observeWaitedPrs } from '../src/pr-waits.js';
import { deriveGlassPrs } from '../src/glass-prs.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const ref = (n: number) => parsePrRef(`pr:acme/web#${n}`)!;
const view = (n: number): GhPrView => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: `sha${n}`,
  baseRefName: 'main',
  headRefName: `b${n}`,
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  reviews: [],
  statusCheckRollup: [],
});

it('publishes changed snapshots even when another poller checked those watches just before the batch', () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const entry = process.argv[1];
  process.argv[1] = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  try {
    for (const n of [1, 2, 3]) {
      upsertPr(prEvidence(ref(n), view(n), new Date(now - 60_000).toISOString()));
      addPrWatch(ref(n));
    }
  } finally {
    process.argv[1] = entry;
  }
  let changed = false;
  const run = vi.fn((query: string) => {
    const repository: Record<string, unknown> = {
      pr1: snapshot(1, changed ? 'MERGED' : 'OPEN'),
      pr2: { ...snapshot(2), headRefOid: changed ? 'new-head' : 'old-head', mergeStateStatus: changed ? 'CLEAN' : 'DIRTY' },
      pr3: snapshot(3),
    };
    for (const m of query.matchAll(/(link\d+):pullRequests/g)) repository[m[1]!] = { nodes: [] };
    return { status: 0, stdout: JSON.stringify({ data: { repository } }) };
  });
  syncPrWatches(now, { run });
  expect(readPr(ref(2).key)).toMatchObject({ headSha: 'old-head', mergeStateStatus: 'DIRTY' });
  // A second poller consumes the old cycle immediately before the next batch.
  // The batch has another due watch, but these two are no longer individually due.
  for (const n of [1, 2]) runWatchCheck(readWatch(ref(n).key)!, new Date(now + 44_000));
  changed = true;
  vi.setSystemTime(now + 45_000);
  syncPrWatches(now + 45_000, { run });
  expect(run).toHaveBeenCalledTimes(2);
  // Their next checks must consume the NEW batch, never the previous snapshot.
  const merged = runWatchCheck(readWatch(ref(1).key)!, new Date(now + 89_000));
  runWatchCheck(readWatch(ref(2).key)!, new Date(now + 89_000));
  expect(readPr(ref(1).key)).toMatchObject({ state: 'MERGED', observedAt: new Date(now + 45_000).toISOString() });
  expect(readPr(ref(2).key)).toMatchObject({
    headSha: 'new-head',
    mergeStateStatus: 'CLEAN',
    observedAt: new Date(now + 45_000).toISOString(),
  });
  const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  expect(decode(merged.watch.cursor)).toMatchObject({ s: 'MERGED' });
  expect(decode(readWatch(ref(2).key)!.cursor)).toMatchObject({ h: 'new-head', m: 'CLEAN' });
  expect(listNotices(100).filter((n) => n.kind === 'pr-merged')).toHaveLength(1);
  expect(repairKind(readPr(ref(2).key)!)).toBeUndefined();
  expect(deriveGlassPrs([], [], readPrs()).prs.find((p) => p.number === 1)?.state).toBe('MERGED');
  syncPrWatches(now + 90_000, { run });
  expect(readWatch(ref(1).key)).toBeUndefined();
  expect(listNotices(100).filter((n) => n.kind === 'pr-merged')).toHaveLength(1);
});
function snapshot(n: number, state = 'OPEN', conclusion = 'SUCCESS') {
  return {
    ...view(n),
    state,
    number: n,
    url: ref(n).url,
    ...(state === 'MERGED' ? { mergedAt: new Date().toISOString() } : {}),
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion }] } } },
        },
      ],
    },
  };
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-batch-integration-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('the shipped subprocess consumes one batch for mixed owners, records a terminal notice once and retires it', () => {
  const id = '12345678-1234-4123-8123-123456789012';
  enqueue({ id, repo: 'web', brief: 'work' }, 'work');
  appendStatus(id, 'work', 'done', 'opened the PR');
  const now = Date.now();
  const entry = process.argv[1];
  process.argv[1] = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  try {
    for (const n of [1, 2]) {
      upsertPr(prEvidence(ref(n), view(n), new Date(now - 60_000).toISOString()));
      addPrWatch(ref(n), n === 1 ? { forId: id } : {});
    }
  } finally {
    process.argv[1] = entry;
  }
  let merged = false;
  const run = vi.fn((query: string) => {
    const repository: Record<string, unknown> = {
      pr1: snapshot(1, merged ? 'MERGED' : 'OPEN'),
      pr2: snapshot(2, 'OPEN', merged ? 'FAILURE' : 'SUCCESS'),
    };
    // Negative stack links are in this batch; no child gh calls are needed.
    for (const m of query.matchAll(/(link\d+):pullRequests/g)) repository[m[1]!] = { nodes: [] };
    return { status: 0, stdout: JSON.stringify({ data: { repository } }) };
  });
  expect(syncPrWatches(now, { run }).refreshed).toBe(2);
  expect(readPr(ref(1).key)?.dispatches).toEqual([id]);
  expect(readPr(ref(2).key)?.checks.passed).toBe(1);
  appendStatus(id, 'work', 'paused', 'waiting for the helm PR', { waitingOn: 'pr', link: ref(2).url });
  const extraView = vi.fn(() => view(2));
  expect(observeWaitedPrs({ now: now + 60_000, view: extraView })).toEqual([]);
  expect(extraView).not.toHaveBeenCalled();
  merged = true;
  expect(syncPrWatches(now + 45_000, { run }).refreshed).toBe(2);
  expect(listWatches().map((w) => w.key)).toEqual([ref(2).key]);
  expect(listNotices(100).filter((n) => n.kind === 'pr-merged')).toHaveLength(1);
  expect(readWatchEvents(ref(2).key)).toEqual([expect.objectContaining({ kind: 'check-completed', conclusion: 'FAILURE' })]);
  syncPrWatches(now + 90_000, { run });
  expect(run).toHaveBeenCalledTimes(3);
  expect(run.mock.calls[2]![0]).not.toContain('pr1:pullRequest');
  expect(listNotices(100).filter((n) => n.kind === 'pr-merged')).toHaveLength(1);
});
