import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addWatch, appendStatus, appendWatchEvents, enqueue, ensureLayout, laneDirs, mergeEvidence, readPr, upsertPr } from '@lobstah/core';
import type { Descriptor, PrEvidence } from '@lobstah/core';
import { branchOwnership, repairBrief } from '@lobstah/core';
import { tick } from '@lobstah/supervisor';
import { deliverDispatchOwned } from '../../pick/src/loops/watch.js';
import { deliverPrRepairs, stampRepairerBeat } from '../src/pr-repair.js';
import { observeDispatchPrWatches } from '../src/pr-watch.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const URL = 'https://github.com/acme/web/pull/17';
const KEY = 'pr:acme/web#17';
let dir: string;

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: URL,
  number: 17,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'DIRTY',
  headSha: SHA,
  baseRefName: 'stack-parent',
  headRefName: 'stack-child',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: new Date().toISOString(),
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
  return fs
    .readdirSync(laneDirs('work').queue)
    .filter((f) => f.endsWith('.json'))
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
  it('starts one repair from the daemon with no pickup configured, after the first-observation baseline', () => {
    upsertPr(pr(), OWNER);
    const daemonTick = () =>
      tick(() => {}, {
        prWatches: (now, log) => {
          deliverPrRepairs(log, 3);
          stampRepairerBeat(now);
        },
        spawnRunner: () => {},
      });
    daemonTick();
    expect(readPr(KEY)?.repair).toBeUndefined();
    upsertPr(pr(), OWNER);
    daemonTick();
    const id = readPr(KEY)?.repair?.dispatchId;
    expect(id).toBeTruthy();
    expect(fs.existsSync(path.join(laneDirs('work').active, id!, 'descriptor.json'))).toBe(true);
    daemonTick();
    expect(readPr(KEY)?.repair?.dispatchId).toBe(id);
  });

  it.skipIf(process.platform === 'win32')('the daemon observes and repairs a PR without pickup or a helm', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const gh = path.join(bin, 'gh');
    const view = {
      state: 'OPEN',
      isDraft: false,
      headRefOid: SHA,
      baseRefName: 'main',
      headRefName: 'feature',
      mergeStateStatus: 'DIRTY',
      reviewDecision: '',
      statusCheckRollup: [],
    };
    fs.writeFileSync(
      gh,
      `#!/bin/sh\nif [ "$1" = "pr" ]; then echo '${JSON.stringify(view)}'; else echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'; fi\n`,
    );
    fs.chmodSync(gh, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      let now = Date.now();
      const daemonTick = () =>
        tick(() => {}, {
          now: () => now,
          prWatches: (at, log) => {
            observeDispatchPrWatches(45, at);
            deliverPrRepairs(log, 3);
            stampRepairerBeat(at);
          },
          spawnRunner: () => {},
        });
      daemonTick();
      expect(readPr(KEY)?.observations).toBe(1);
      expect(readPr(KEY)?.repair).toBeUndefined();
      now += 46_000;
      daemonTick();
      expect(readPr(KEY)?.observations).toBe(2);
      expect(readPr(KEY)?.repair?.status).toBe('repairing');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('two repairer processes claim only one follow-up', async () => {
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    const moduleUrl = pathToFileURL(path.resolve('apps/cli/dist/pr-repair.js')).href;
    const code = `import { deliverPrRepairs } from ${JSON.stringify(moduleUrl)}; deliverPrRepairs(() => {}, 3);`;
    const run = () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, LOBSTAH_HOME: dir } });
        child.once('error', reject);
        child.once('exit', (status) => resolve(status ?? -1));
      });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(queued()).toHaveLength(1);
    expect(readPr(KEY)?.repair?.dispatchId).toBe(queued()[0]?.id);
  });

  it('pickup and the daemon do not start two repairs or spend the generic fork cap twice', () => {
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 1)).toBe(1);
    const OTHER = '22222222-2222-2222-2222-222222222222';
    const done = path.join(laneDirs('work').done, OTHER);
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: OTHER, repo: 'web', brief: 'watch' } satisfies Descriptor));
    appendStatus(OTHER, 'work', 'done', 'watched');
    addWatch('ci:other', 'echo {}', { owner: `dispatch:${OTHER}` });
    appendWatchEvents('ci:other', [{ seq: 1, summary: 'failed', at: new Date().toISOString() }]);
    deliverDispatchOwned(() => {}, 1);
    expect(queued()).toHaveLength(2); // one repair and one generic continuation
    expect(deliverPrRepairs(() => {}, 1)).toBe(0);
    expect(queued()).toHaveLength(2);
  });

  it('addresses a repair to its signed-on trap even when the trap has not parked', () => {
    const trap = {
      trapId: 'gone',
      worktree: '/tmp/gone',
      cwd: '/tmp/gone',
      harness: 'codex',
      sessionId: 'session',
      signedOnAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'soaking', 'gone.json'), JSON.stringify(trap));
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    expect(queued()[0]?.for).toBe('wt:gone');
  });

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
    expect(readPr(KEY)?.repair).toMatchObject({
      kind: 'conflict',
      status: 'repairing',
      attempts: 1,
      maxAttempts: 2,
      dispatchId: dispatch.id,
    });
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
  });

  it('includes failing check names and URLs in a single repair follow-up', () => {
    const bad = pr({
      mergeStateStatus: 'BLOCKED',
      checks: { total: 2, passed: 1, failed: 1, pending: 0 },
      failingChecks: [{ name: 'test', detailsUrl: 'https://ci/run/1' }],
    });
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

  it('can turn conflict repair off while leaving check repair on', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nconflicts = false\nchecks = true\n');
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    const failed = pr({
      mergeStateStatus: 'BLOCKED',
      checks: { total: 1, passed: 0, failed: 1, pending: 0 },
      failingChecks: [{ name: 'test' }],
    });
    upsertPr(failed, OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(1);
    expect(readPr(KEY)?.repair?.kind).toBe('checks');
  });

  it('does not repair when a person committed after the last dispatch commit', () => {
    const known = { sha: SHA, author: { login: 'lobstah' }, committer: { login: 'lobstah' } };
    const person = { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: { login: 'person' }, committer: { login: 'person' } };
    expect(branchOwnership([known, person], new Set([SHA]))).toMatchObject({
      safe: false,
      reason: 'person commits since the last lobstah commit',
    });
    expect(branchOwnership([known], new Set([SHA]))).toEqual({ safe: true });
    expect(branchOwnership([person], new Set([SHA])).safe).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('records a person commit as a blocked repair', () => {
    const newer = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(
      gh,
      `#!/bin/sh\necho '${JSON.stringify([
        { sha: SHA, author: { login: 'lobstah' }, committer: { login: 'lobstah' } },
        { sha: newer, author: { login: 'person' }, committer: { login: 'person' } },
      ])}'\n`,
    );
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

  it('does not fork beside a queued member of the owning chain', () => {
    upsertPr(pr(), OWNER);
    upsertPr(pr(), OWNER);
    enqueue({ id: '22222222-2222-2222-2222-222222222222', repo: 'web', brief: 'manual follow-up', followUp: OWNER }, 'work');
    expect(deliverPrRepairs(() => {}, 3)).toBe(0);
    expect(queued()).toHaveLength(1);
    expect(readPr(KEY)?.repair).toBeUndefined();
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
