import { describe, expect, it } from 'vitest';
import type { PrEvidence, PrRecord } from '@lobstah/core';
import { deriveGlassPrs } from '../src/glass-prs.js';
import { prBadgeClass } from '../src/glass-diff.js';

// The page's badge class: the same function the glass bundle imports.

const branches = ['main', 'glass', 'evidence', 'kinds', 'acks', 'tabs'];
const numbers = [26, 27, 29, 32, 33];
const row = (n: number, base: string, head: string, state = 'OPEN', repo = 'lobstah') => ({
  id: `dispatch-${n}`,
  pr: {
    url: `https://github.com/aequitas-labs/${repo}/pull/${n}`,
    number: n, state, draft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    headSha: `sha-${n}`, baseRefName: base, headRefName: head,
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    observedAt: `2026-09-23T00:${String(n).padStart(2, '0')}:00Z`,
  } satisfies PrEvidence,
});
/** A PR record as core prs.ts writes it. */
const rec = (n: number, base: string, head: string, over: Partial<PrRecord> = {}): PrRecord => ({
  ...row(n, base, head).pr,
  key: `pr:aequitas-labs/lobstah#${n}`,
  repo: 'aequitas-labs/lobstah',
  dispatches: [],
  standingSince: {},
  firstSeenAt: `2026-09-20T00:${String(n).padStart(2, '0')}:00Z`,
  ...over,
});
const five = () => numbers.map((n, i) => row(n, branches[i]!, branches[i + 1]!));

describe('glass PR stacks', () => {
  it('orders a five PR stack and marks exactly the bottom as next mergeable', () => {
    const { prs, stacks } = deriveGlassPrs(five());
    expect(stacks).toMatchObject([{ numbers, floor: 'main', nextNumber: 26, behind: 4 }]);
    expect(prs.filter((p) => p.nextMergeable).map((p) => p.number)).toEqual([26]);
    expect(prs.slice(1).map((p) => p.blockedBy)).toEqual([26, 27, 29, 32]);
  });

  it('promotes the next PR after the bottom merges and GitHub retargets its base', () => {
    const rows = five();
    rows[0] = row(26, 'main', 'glass', 'MERGED');
    rows[1] = row(27, 'main', 'evidence');
    const { prs, stacks } = deriveGlassPrs(rows);
    expect(prs.filter((p) => p.nextMergeable).map((p) => p.number)).toEqual([27]);
    expect(stacks.find((s) => s.nextNumber === 27)?.numbers).toEqual([27, 29, 32, 33]);
    expect(stacks.at(-1)?.numbers).toEqual([26]);
  });

  it('colors PR state badges as GitHub does: merged purple, open green, draft grey, closed red', () => {
    const rows = five();
    rows[0] = row(26, 'main', 'glass', 'MERGED');
    rows[1] = row(27, 'glass', 'evidence', 'CLOSED');
    rows[2] = { ...row(29, 'evidence', 'kinds'), pr: { ...row(29, 'evidence', 'kinds').pr, draft: true } };
    rows[3] = { ...row(32, 'kinds', 'acks'), pr: { ...row(32, 'kinds', 'acks').pr, checks: { total: 2, passed: 1, failed: 1, pending: 0 } } };
    const cls = new Map(deriveGlassPrs(rows).prs.map((p) => [p.number, prBadgeClass(p.badge)]));
    expect(cls.get(26)).toBe('pr-merged');
    expect(cls.get(27)).toBe('pr-closed');
    expect(cls.get(29)).toBe('pr-draft');
    expect(cls.get(32)).toBe('bad'); // open with failed checks keeps its news
    expect(cls.get(33)).toBe('pr-open');
  });

  it('shows an untracked base as a plain branch floor', () => {
    const { prs, stacks } = deriveGlassPrs([row(34, 'release', 'feature')]);
    expect(stacks[0]?.floor).toBe('release');
    expect(prs[0]?.blockedBy).toBeUndefined();
  });

  it('keeps two independent stacks separate, including different repos', () => {
    const { stacks } = deriveGlassPrs([...five(), row(30, 'main', 'settings'), row(34, 'main', 'other', 'OPEN', 'other')]);
    expect(stacks.map((s) => s.numbers)).toEqual([[34], numbers, [30]]);
  });

  it('orders open stacks by newest first-seen time, then finished ones; observation time plays no part', () => {
    const recs = [
      rec(1, 'main', 'old', { firstSeenAt: '2026-09-21T00:00:00Z', observedAt: '2026-09-25T00:00:00Z' }),
      rec(2, 'main', 'new', { firstSeenAt: '2026-09-23T00:00:00Z', observedAt: '2026-09-21T00:00:00Z' }),
      rec(3, 'main', 'closed', { state: 'MERGED', firstSeenAt: '2026-09-24T00:00:00Z' }),
    ];
    expect(deriveGlassPrs([], [], recs).prs.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it('keeps merged PRs in stack order when upper PRs still refer to them', () => {
    const rows = five();
    rows[0] = row(26, 'main', 'glass', 'MERGED');
    rows[1] = row(27, 'glass', 'evidence', 'MERGED');
    const { prs, stacks } = deriveGlassPrs(rows);
    expect(stacks[0]?.numbers).toEqual(numbers);
    expect(prs.map((p) => p.number)).toEqual(numbers);
    expect(prs.filter((p) => p.state === 'MERGED').map((p) => p.number)).toEqual([26, 27]);
    expect(prs.find((p) => p.number === 29)?.nextMergeable).toBe(true);
  });
});

describe('glass PR order: a refresh never reorders', () => {
  /** Two stacks and two single PRs, first seen in number order. */
  const fleet = (): PrRecord[] => [
    rec(10, 'main', 'a1'), rec(11, 'a1', 'a2'),
    rec(12, 'main', 'b1'),
    rec(13, 'main', 'c1'), rec(14, 'c1', 'c2'),
    rec(15, 'main', 'd1', { state: 'MERGED' }),
  ];
  /** The same PRs, observed again at new times and read in another order. */
  const refresh = (recs: PrRecord[], seed: number): PrRecord[] =>
    recs
      .map((r, i) => ({ ...r, observedAt: `2026-09-29T0${(i * seed) % 7}:00:00Z`, updatedAt: `2026-09-29T0${(i + seed) % 5}:00:00Z` }))
      .sort((a, b) => ((a.number * seed) % 11) - ((b.number * seed) % 11));
  const order = (recs: PrRecord[]) => {
    const { prs, stacks } = deriveGlassPrs([], [], recs);
    return { prs: prs.map((p) => p.number), stacks: stacks.map((s) => s.numbers) };
  };

  it('two observations of the same PRs, read in a different order, give the same order', () => {
    const first = order(refresh(fleet(), 3));
    expect(first).toEqual({ prs: [13, 14, 12, 10, 11, 15], stacks: [[13, 14], [12], [10, 11], [15]] });
    expect(order(refresh(fleet(), 5))).toEqual(first);
    expect(order(refresh(fleet(), 7))).toEqual(first);
  });

  it('a newly opened PR goes to the top of the open group; the others keep their order', () => {
    const before = order(fleet());
    const after = order([...refresh(fleet(), 3), rec(9, 'main', 'e1', { firstSeenAt: '2026-09-29T12:00:00Z' })]);
    expect(after.stacks[0]).toEqual([9]);
    expect(after.stacks.slice(1)).toEqual(before.stacks);
  });

  it('a merge moves its stack to the finished group and leaves the rest in place', () => {
    const before = order(fleet());
    const merged = refresh(fleet(), 5).map((r) => (r.number === 12 ? { ...r, state: 'MERGED' } : r));
    const after = order(merged);
    expect(after.stacks).toEqual([[13, 14], [10, 11], [15], [12]]);
    expect(after.stacks.filter((s) => s[0] !== 12)).toEqual(before.stacks.filter((s) => s[0] !== 12));
  });

  it('a record with no first-seen time sorts by number below the dated ones', () => {
    const recs = fleet().map((r) => (r.number === 10 || r.number === 12 ? { ...r, firstSeenAt: undefined } : r));
    const first = order(recs);
    expect(first.stacks).toEqual([[13, 14], [12], [10, 11], [15]]);
    expect(order(refresh(recs, 7))).toEqual(first);
  });

  it('two PRs with the same head branch: the parent is the one first seen last, on every refresh', () => {
    const recs = [
      rec(20, 'main', 'feature', { state: 'CLOSED', firstSeenAt: '2026-09-20T00:00:00Z' }),
      rec(21, 'main', 'feature', { firstSeenAt: '2026-09-22T00:00:00Z' }),
      rec(22, 'feature', 'top', { firstSeenAt: '2026-09-23T00:00:00Z' }),
    ];
    for (const seed of [1, 3, 5, 7]) {
      const { prs } = deriveGlassPrs([], [], refresh(recs, seed));
      const top = prs.find((p) => p.number === 22)!;
      expect(top.stackId).toBe('pr:aequitas-labs/lobstah#21');
      expect(top.blockedBy).toBe(21);
    }
  });
});
