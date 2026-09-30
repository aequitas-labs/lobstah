import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, executorPath, mergeEvidence, prNewestFirst, readPr, readPrs, upsertPr, writePr } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The PR order is the first-seen time, stored once in the PR record. A
 * refresh (a new observation) rewrites observedAt and never the order.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-prorder-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const obs = (n: number, observedAt: string, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n),
  number: n,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  headSha: `sha${n}`,
  baseRefName: 'main',
  headRefName: `branch-${n}`,
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt,
  ...over,
});
const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, '0')}:00.000Z`;
const ordered = () => {
  const recs = readPrs();
  return recs.sort(prNewestFirst(recs)).map((r) => r.number);
};

describe('PR records: first-seen time', () => {
  it('the first observation sets firstSeenAt; later observations never rewrite it', () => {
    upsertPr(obs(5, at(1)));
    expect(readPr('pr:acme/web#5')?.firstSeenAt).toBe(at(1));
    upsertPr(obs(5, at(9), { draft: true }));
    expect(readPr('pr:acme/web#5')).toMatchObject({ firstSeenAt: at(1), observedAt: at(9), draft: true });
  });

  it('a record with no first-seen time sorts by number, then gets one that stays fixed', () => {
    upsertPr(obs(30, at(5)));
    // Two records written before firstSeenAt existed.
    for (const n of [7, 12]) {
      const { after } = upsertPr(obs(n, at(1)));
      const { firstSeenAt: _, ...legacy } = after;
      writePr(legacy);
    }
    expect(readPr('pr:acme/web#7')?.firstSeenAt).toBeUndefined();
    expect(ordered()).toEqual([30, 12, 7]);

    upsertPr(obs(7, at(20)));
    const stamped = readPr('pr:acme/web#7')?.firstSeenAt;
    expect(stamped).toBe(at(5));
    expect(ordered()).toEqual([30, 12, 7]);

    upsertPr(obs(12, at(21)));
    upsertPr(obs(7, at(22)));
    expect(readPr('pr:acme/web#7')?.firstSeenAt).toBe(stamped);
    expect(readPr('pr:acme/web#12')?.firstSeenAt).toBe(stamped);
    expect(ordered()).toEqual([30, 12, 7]);
  });
});

describe('man tend: a refresh never reorders', () => {
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];

  it('prints stack lines and the work table in the same order across two refreshes', () => {
    // Stack #3 → #4, then #1 alone, then #2 alone, first seen in that order.
    upsertPr(obs(3, at(1)));
    upsertPr(obs(4, at(2), { baseRefName: 'branch-3' }));
    upsertPr(obs(1, at(3)));
    upsertPr(obs(2, at(4)));
    // Three live dispatches, one per PR stack.
    ids.forEach((id, i) => {
      enqueue({ id, repo: 'web', brief: `b${i}` }, 'work');
      claimNext('work');
      appendStatus(id, 'work', 'working');
    });
    mergeEvidence(ids[0]!, 'work', { prUrl: url(3) });
    mergeEvidence(ids[1]!, 'work', { prUrl: url(1) });
    mergeEvidence(ids[2]!, 'work', { prUrl: url(2) });

    const view = () => {
      const text = renderTend(buildTendReport());
      const stacks = text.split('\n').filter((l) => l.includes('stack #'));
      const work = buildTendReport().stories.map((s) => s.prUrl);
      return { stacks, work };
    };
    const first = view();
    expect(first.stacks.map((l) => l.match(/stack (#[^:]+)/)![1])).toEqual(['#2', '#1', '#3 → #4']);
    expect(first.work).toEqual([url(2), url(1), url(3)]);

    // Refresh: every PR observed again, in another order, at new times.
    for (const [n, m] of [[1, 40], [4, 41], [2, 42], [3, 43]] as const) {
      upsertPr(obs(n, at(m), n === 4 ? { baseRefName: 'branch-3' } : {}));
    }
    expect(view()).toEqual(first);
    for (const [n, m] of [[2, 50], [3, 51], [1, 52], [4, 53]] as const) {
      upsertPr(obs(n, at(m), n === 4 ? { baseRefName: 'branch-3' } : {}));
    }
    expect(view()).toEqual(first);
  });
});
