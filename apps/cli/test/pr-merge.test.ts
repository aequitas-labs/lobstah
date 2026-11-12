import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, loadConfig, pendingIds, prMergeStep, queuedDescriptor, readPr, readWatch, upsertPr, writePr } from '@lobstah/core';
import type { PrEvidence, PrMergeMethod, PrRecord } from '@lobstah/core';
import { PrMergeRefused, cancelPrMerge, mergeRequestedPrs, openPrBelow, prMergeMethod, repoKeyForForge, requestPrMerge } from '../src/pr-merge.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const config = (extra = '') =>
  fs.writeFileSync(path.join(home, 'config.toml'), `readySettleSecs = 0\n[repos.web]\npath = "/missing"\norigin = "git@github.com:acme/web.git"\n${extra}`);
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-prmerge-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  config();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const key = (n: number) => `pr:acme/web#${n}`;
const obs = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n),
  number: n,
  title: `PR ${n}`,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  headSha: `sha${n}`,
  baseRefName: 'main',
  headRefName: `branch-${n}`,
  checks: { total: 2, passed: 2, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: new Date().toISOString(),
  author: 'chris',
  ...over,
});
const me = () => 'chris';
const record = (over: Partial<PrRecord> = {}): PrRecord => ({ ...upsertPr(obs(1)).after, ...over });

describe('prMergeStep', () => {
  it('merges a green, clean PR and waits on drafts, running checks, the PR below and GitHub', () => {
    expect(prMergeStep(record(), false)).toEqual({ kind: 'merge' });
    expect(prMergeStep(record({ draft: true }), false)).toMatchObject({ kind: 'wait', why: 'a draft' });
    expect(prMergeStep(record({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }), false)).toMatchObject({ kind: 'wait' });
    expect(prMergeStep(record(), true)).toMatchObject({ kind: 'wait', why: 'a PR below it in its stack merges first' });
    expect(prMergeStep(record({ mergeStateStatus: 'BLOCKED' }), false)).toMatchObject({ kind: 'wait', why: 'GitHub says blocked' });
  });

  it('repairs a conflict or failing checks, and is stuck once that head’s repair gave up', () => {
    expect(prMergeStep(record({ mergeStateStatus: 'DIRTY' }), false)).toEqual({ kind: 'repair', why: 'conflict' });
    expect(prMergeStep(record({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } }), false)).toEqual({ kind: 'repair', why: 'checks' });
    const gaveUp = { kind: 'checks' as const, attempts: 3, status: 'gave-up' as const, reason: 'three rounds', headSha: 'sha1' };
    expect(prMergeStep(record({ mergeStateStatus: 'DIRTY', repair: gaveUp }), false)).toEqual({ kind: 'stuck', why: 'three rounds' });
    // A new head is a new chance.
    expect(prMergeStep(record({ mergeStateStatus: 'DIRTY', repair: { ...gaveUp, headSha: 'older' } }), false)).toMatchObject({ kind: 'repair' });
  });

  it('is done once the PR merges or closes', () => {
    expect(prMergeStep(record({ state: 'MERGED' }), false)).toEqual({ kind: 'done' });
    expect(prMergeStep(record({ state: 'CLOSED' }), false)).toEqual({ kind: 'done' });
  });
});

describe('merge method', () => {
  it('takes the repo’s method, then pick’s, then squash', () => {
    expect(repoKeyForForge({ repos: { web: { origin: 'git@github.com:Acme/Web.git' } as never } }, 'acme/web')).toBe('web');
    const repos = { web: { origin: 'git@github.com:acme/web.git', mergeMethod: 'merge' } } as never;
    expect(prMergeMethod({ repos }, 'acme/web', () => 'rebase')).toBe('merge');
    expect(prMergeMethod({ repos }, 'acme/other', () => 'rebase')).toBe('rebase');
    expect(prMergeMethod({ repos }, 'acme/other', () => undefined)).toBe('squash');
  });

  it('reads a repo’s mergeMethod and refuses anything else', () => {
    config('mergeMethod = "rebase"\n');
    expect(loadConfig().repos.web!.mergeMethod).toBe('rebase');
    config('mergeMethod = "fast-forward"\n');
    expect(() => loadConfig()).toThrow('repos.web.mergeMethod must be');
  });
});

describe('requestPrMerge', () => {
  it('refuses a PR it has no record of, a closed one, and someone else’s', () => {
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof PrMergeRefused ? error.status : error;
      }
      return 'no refusal';
    };
    expect(refusal(() => requestPrMerge(key(9), 'glass', { viewer: me }))).toBe(404);
    upsertPr(obs(2, { state: 'CLOSED' }));
    expect(refusal(() => requestPrMerge(key(2), 'glass', { viewer: me }))).toBe(409);
    upsertPr(obs(3, { author: 'someone-else' }));
    expect(refusal(() => requestPrMerge(key(3), 'glass', { viewer: me }))).toBe(403);
    expect(readPr(key(3))!.mergeRequest).toBeUndefined();
  });

  it('stores the request with the repo’s method, adds a watch, and cancels', () => {
    config('mergeMethod = "merge"\n');
    upsertPr(obs(4));
    const request = requestPrMerge(key(4), 'wharf', { viewer: me, now: Date.parse('2026-11-11T10:00:00Z') });
    expect(request).toEqual({ at: '2026-11-11T10:00:00.000Z', by: 'wharf', method: 'merge' });
    expect(readPr(key(4))!.mergeRequest).toEqual(request);
    expect(readWatch(key(4))).toBeDefined();
    // Asking again keeps the first request.
    expect(requestPrMerge(key(4), 'glass', { viewer: me })).toEqual(request);
    expect(cancelPrMerge(key(4))).toBe(true);
    expect(readPr(key(4))!.mergeRequest).toBeUndefined();
    expect(cancelPrMerge(key(4))).toBe(false);
  });

  it('takes a dispatch’s PR when gh can’t say who signs in', () => {
    upsertPr(obs(5, { author: undefined }), 'dispatch-a');
    expect(requestPrMerge(key(5), 'glass', { viewer: () => undefined }).method).toBe('squash');
  });
});

describe('mergeRequestedPrs', () => {
  const ask = (n: number, over: Partial<PrEvidence> = {}, dispatch?: string) => {
    upsertPr(obs(n, over), dispatch);
    return requestPrMerge(key(n), 'glass', { viewer: me });
  };
  const merges: Array<[string, PrMergeMethod]> = [];
  const merge = (pr: PrRecord, method: PrMergeMethod) => {
    merges.push([pr.key, method]);
    return { ok: true as const };
  };
  beforeEach(() => {
    merges.length = 0;
  });
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  it('merges a green PR with its method and clears the request', () => {
    ask(1);
    mergeRequestedPrs(log, { merge });
    expect(merges).toEqual([[key(1), 'squash']]);
    expect(readPr(key(1))!.mergeRequest).toBeUndefined();
  });

  it('keeps the request when gh refuses, to try again next tick', () => {
    ask(1);
    mergeRequestedPrs(log, { merge: () => ({ ok: false, why: 'Head branch was modified' }) });
    expect(readPr(key(1))!.mergeRequest).toBeDefined();
    expect(logs.at(-1)).toContain('Head branch was modified');
  });

  it('merges a stack from the bottom', () => {
    ask(1);
    ask(2, { baseRefName: 'branch-1' });
    mergeRequestedPrs(log, { merge });
    expect(merges.map(([k]) => k)).toEqual([key(1)]);
    expect(readPr(key(2))!.mergeRequest).toBeDefined();
    expect(openPrBelow(readPr(key(2))!, [readPr(key(1))!, readPr(key(2))!])).toBe(true);
  });

  it('files one repair dispatch per head for a PR no dispatch owns, on its branch', () => {
    ask(1, { mergeStateStatus: 'DIRTY' });
    mergeRequestedPrs(log, { merge });
    mergeRequestedPrs(log, { merge });
    const queued = pendingIds('work');
    expect(queued).toHaveLength(1);
    const d = queuedDescriptor(queued[0]!, 'work')!;
    expect(d).toMatchObject({ repo: 'web', trapAny: true });
    expect(d.brief).toContain('Merge `main` into it with a merge commit');
    expect(d.brief).toContain('`branch-1`');
    expect(readPr(key(1))!.mergeRequest!.repair).toEqual({ dispatchId: queued[0], headSha: 'sha1' });
    expect(merges).toEqual([]);

    // A new head that still conflicts gets its own.
    upsertPr(obs(1, { mergeStateStatus: 'DIRTY', headSha: 'sha1b' }));
    mergeRequestedPrs(log, { merge });
    expect(pendingIds('work')).toHaveLength(2);
  });

  it('leaves a dispatch’s PR to the PR repair it already has', () => {
    ask(1, { checks: { total: 1, passed: 0, failed: 1, pending: 0 } }, 'dispatch-a');
    mergeRequestedPrs(log, { merge });
    expect(pendingIds('work')).toEqual([]);
  });

  it('tells the helm once per head when its repair stopped', () => {
    ask(1, { mergeStateStatus: 'DIRTY' }, 'dispatch-a');
    const pr = readPr(key(1))!;
    writePr({ ...pr, repair: { kind: 'conflict', attempts: 3, status: 'gave-up', reason: 'three rounds without progress', headSha: 'sha1' } });
    mergeRequestedPrs(log, { merge });
    mergeRequestedPrs(log, { merge });
    const stuck = listNotices(50).filter((n) => n.kind === 'repair-stopped' && n.refId === key(1));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.text).toContain('three rounds without progress');
  });

  it('drops the request once the PR merged or closed', () => {
    ask(1);
    upsertPr(obs(1, { state: 'MERGED' }));
    mergeRequestedPrs(log, { merge });
    expect(merges).toEqual([]);
    expect(readPr(key(1))!.mergeRequest).toBeUndefined();
  });
});
