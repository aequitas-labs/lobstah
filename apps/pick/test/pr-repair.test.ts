import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, appendStatus, ensureLayout, laneDirs, mergeEvidence, readPr, upsertPr } from '@lobstah/core';
import type { Descriptor, PrEvidence } from '@lobstah/core';
import { branchOwnership, deliverPrRepairs, repairBrief } from '../src/loops/watch.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const URL = 'https://github.com/acme/web/pull/17';
const KEY = 'pr:acme/web#17';
let dir: string;

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: URL, number: 17, state: 'OPEN', draft: false, reviewDecision: '',
  mergeStateStatus: 'DIRTY', headSha: SHA, baseRefName: 'stack-parent', headRefName: 'stack-child',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 }, observedAt: new Date().toISOString(),
  ...over,
});

function owner(): void {
  const done = path.join(laneDirs('work').done, OWNER);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: OWNER, repo: 'web', brief: 'make PR' } satisfies Descriptor));
  appendStatus(OWNER, 'work', 'done', 'PR sent');
  mergeEvidence(OWNER, 'work', { commits: [SHA], deliveredTo: 'wt:gone' });
  addWatch(KEY, 'echo {}', { owner: `dispatch:${OWNER}` });
}

function queued(): Descriptor[] {
  return fs.readdirSync(laneDirs('work').queue).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as Descriptor);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-repair-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
  owner();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PR watch repairs', () => {
  it('does not repair a first observation, then follows up a conflict against the PR base', () => {
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    expect(queued()).toHaveLength(0);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    const dispatch = queued()[0]!;
    expect(dispatch.followUp).toBe(OWNER);
    expect(dispatch.brief).toContain('base branch stack-parent');
    expect(dispatch.brief).toContain('--force-with-lease only if you rebased');
    expect(readPr(KEY)?.repair).toMatchObject({ kind: 'conflict', status: 'repairing', attempts: 1, maxAttempts: 2, dispatchId: dispatch.id });
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
  });

  it('includes failing check names and URLs in a single repair follow-up', () => {
    const bad = pr({ mergeStateStatus: 'BLOCKED', checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failingChecks: [{ name: 'test', detailsUrl: 'https://ci/run/1' }] });
    upsertPr(bad, OWNER);
    upsertPr(bad, OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    expect(queued()[0]!.brief).toContain('test — https://ci/run/1');
    expect(queued()[0]!.brief).toContain('rerun it at most once');
  });

  it('stops after the per-head cap and records why', () => {
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    appendStatus(readPr(KEY)!.repair!.dispatchId!, 'work', 'done', 'tried');
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    appendStatus(readPr(KEY)!.repair!.dispatchId!, 'work', 'done', 'tried again');
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'gave-up', attempts: 2, reason: 'repair limit reached (2 of 2)' });
  });

  it('autoRepair off leaves the old watch behavior', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nautoRepair = false\n');
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it('does not repair when a person committed after the last dispatch commit', () => {
    const known = { sha: SHA, author: { login: 'lobstah' }, committer: { login: 'lobstah' } };
    const person = { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: { login: 'person' }, committer: { login: 'person' } };
    expect(branchOwnership([known, person], new Set([SHA]))).toMatchObject({ safe: false, reason: 'person commits since the last lobstah commit' });
    expect(branchOwnership([known], new Set([SHA]))).toEqual({ safe: true });
    expect(branchOwnership([person], new Set([SHA])).safe).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('records a person commit as a blocked repair', () => {
    const newer = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\necho '${JSON.stringify([
      { sha: SHA, author: { login: 'lobstah' }, committer: { login: 'lobstah' } },
      { sha: newer, author: { login: 'person' }, committer: { login: 'person' } },
    ])}'\n`);
    fs.chmodSync(gh, 0o755);
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior}`;
    try {
      upsertPr(pr({ headSha: newer }), OWNER);
      upsertPr(pr({ headSha: newer }), OWNER);
      expect(deliverPrRepairs(() => {}, 3)).toBe(0);
      expect(queued()).toHaveLength(0);
      expect(readPr(KEY)?.repair).toMatchObject({ status: 'blocked', reason: 'person commits since the last lobstah commit' });
    } finally {
      process.env.PATH = prior;
    }
  });

  it('caps repairs by the remaining cycle fork budget', () => {
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 0)).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it('uses the requested review changes as work, but not approval', () => {
    const review = pr({ mergeStateStatus: 'CLEAN', review: { changesRequested: true } });
    upsertPr(review, OWNER);
    upsertPr(review, OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    expect(queued()[0]!.brief).toContain('requested review changes');
    expect(repairBrief(readPr(KEY)!, 'review')).toContain('gh pr view --comments');
  });
});
