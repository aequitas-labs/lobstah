import { describe, expect, it } from 'vitest';
import { repairBrief, standalonePr } from '../src/index.js';
import type { PrRecord } from '../src/index.js';

const pr = (baseRefName: string): PrRecord =>
  ({
    key: 'pr:acme/web#7',
    repo: 'acme/web',
    url: 'https://github.com/acme/web/pull/7',
    number: 7,
    state: 'OPEN',
    draft: false,
    reviewDecision: '',
    mergeStateStatus: 'DIRTY',
    headSha: 'a'.repeat(40),
    headRefName: 'feature/tray',
    baseRefName,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    dispatches: [],
    standingSince: {},
    observedAt: '2026-09-30T00:00:00Z',
  }) as PrRecord;

describe('a conflict repair brings the PR up to date by the PR kind', () => {
  it('a standalone PR (based on trunk) merges its base in and pushes normally', () => {
    const brief = repairBrief(pr('main'), 'conflict', { id: 'r1', trunk: 'main' });
    expect(brief).toContain('Fetch origin/main and merge it into feature/tray with a merge commit (`git merge origin/main`)');
    expect(brief).toContain('Do not rebase, and do not force-push');
    expect(brief).toContain('fetch feature/tray, merge the moved head into your branch, and push again with a normal push');
    expect(brief).toContain('Never force-push.');
    expect(brief).not.toContain('--force-with-lease');
  });

  it('a stacked PR (based on another branch) rebases onto its base and pushes with a lease', () => {
    const brief = repairBrief(pr('feature/base'), 'conflict', { id: 'r1', trunk: 'main' });
    expect(brief).toContain('This PR is stacked on its base branch feature/base. Fetch origin/feature/base and rebase feature/tray onto it');
    expect(brief).toContain('--force-with-lease=feature/tray:');
    expect(brief).not.toContain('git merge origin/');
  });

  it('checks and review repairs keep the rebase push rule', () => {
    for (const kind of ['checks', 'review'] as const) {
      const brief = repairBrief(pr('main'), kind, { id: 'r1', trunk: 'main' });
      expect(brief).toContain('rebase your commits onto the moved head again');
      expect(brief).not.toContain('git merge origin/');
    }
  });

  it('standalone means based on the trunk, and needs both known', () => {
    expect(standalonePr('main', 'main')).toBe(true);
    expect(standalonePr('feature/base', 'main')).toBe(false);
    expect(standalonePr(undefined, 'main')).toBe(false);
    expect(standalonePr('main', undefined)).toBe(false);
  });
});

describe('a repair that changes the head of a reviewed PR', () => {
  it('re-requests review from its current reviewers and parks on it, instead of done', () => {
    for (const reviewed of [{ reviewDecision: 'APPROVED' }, { reviewDecision: 'CHANGES_REQUESTED' }, { review: { changesRequested: false, lastReviewAt: '2026-09-30T00:00:00Z' } }]) {
      for (const kind of ['conflict', 'checks', 'review'] as const) {
        const brief = repairBrief({ ...pr('main'), ...reviewed } as PrRecord, kind, { id: 'r1', trunk: 'main' });
        expect(brief).toContain('re-request review from its current reviewers');
        expect(brief).toContain('gh pr view 7 --repo acme/web --json reviews,reviewRequests');
        expect(brief).toContain('gh pr edit 7 --repo acme/web --add-reviewer');
        expect(brief).toContain('lobstah report r1 paused "<note>" --waiting-on review --link https://github.com/acme/web/pull/7');
        expect(brief).not.toContain('Report done with the same PR URL.');
      }
    }
  });

  it('a PR with no review yet reports done as before', () => {
    const brief = repairBrief(pr('main'), 'conflict', { id: 'r1', trunk: 'main' });
    expect(brief).toContain('Report done with the same PR URL.');
    expect(brief).not.toContain('re-request review');
  });
});
