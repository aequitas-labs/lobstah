import { describe, expect, it } from 'vitest';
import type { PrEvidence } from '@lobstah/core';
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

  it('orders open stacks by newest observation, then closed history by newest observation', () => {
    const rows = [
      row(1, 'main', 'old'), row(2, 'main', 'new'), row(3, 'main', 'closed', 'MERGED'),
    ];
    rows[0]!.pr.observedAt = '2026-09-21T00:00:00Z';
    rows[1]!.pr.observedAt = '2026-09-23T00:00:00Z';
    rows[2]!.pr.observedAt = '2026-09-24T00:00:00Z';
    expect(deriveGlassPrs(rows).prs.map((p) => p.number)).toEqual([2, 1, 3]);
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
