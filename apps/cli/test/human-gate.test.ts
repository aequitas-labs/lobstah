import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  appendStatus,
  appendWatchEvents,
  ensureLayout,
  laneDirs,
  matchesGate,
  mergeEvidence,
  readEvidence,
  readPr,
  loadConfig,
  readWatch,
  repairBrief,
  upsertPr,
} from '@lobstah/core';
import type { Descriptor, PrEvidence, PrRecord } from '@lobstah/core';
import { deliverDispatchOwned } from '../../pick/src/loops/watch.js';
import { deliverPrRepairs, recordReportedGates, stampRepairerBeat } from '../src/pr-repair.js';
import { humanPrAttention } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const URL = 'https://github.com/acme/web/pull/17';
const KEY = 'pr:acme/web#17';
const GATE = 'owner approval';
const SETTLED = '[watch]\nrepairSettleSecs = 0\n';
/** The latest runs still fail, as the repairer re-reads them. */
const stillFailing = {
  readChecks: (p: PrRecord) => ({ headSha: p.headSha, checks: (p.failingChecks ?? []).map((c) => ({ name: c.name, outcome: 'failed' as const })) }),
};
let dir: string;

const red = (names: string[], headSha = SHA): PrEvidence => ({
  url: URL,
  number: 17,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'BLOCKED',
  headSha,
  headRefName: 'feature',
  checks: { total: names.length + 1, passed: 1, failed: names.length, pending: 0 },
  failingChecks: names.map((name) => ({ name, detailsUrl: `https://ci/${encodeURIComponent(name)}` })),
  observedAt: new Date().toISOString(),
});

function config(extra = ''): void {
  fs.writeFileSync(path.join(dir, 'config.toml'), `${SETTLED}${extra}`);
}

function owner(): void {
  const done = path.join(laneDirs('work').done, OWNER);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: OWNER, repo: 'web', brief: 'make PR' } satisfies Descriptor));
  appendStatus(OWNER, 'work', 'done', 'PR sent');
  mergeEvidence(OWNER, 'work', { commits: [SHA, NEXT], prUrl: URL });
  addWatch(KEY, 'echo {}', { owner: `dispatch:${OWNER}` });
}

function queued(): Descriptor[] {
  return (['work', 'chore'] as const).flatMap((lane) => fs
    .readdirSync(laneDirs(lane).queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs(lane).queue, f), 'utf8')) as Descriptor));
}

/** Observe the PR `n` times and run the repairer after each observation. Returns the repairs started. */
function observeAndRepair(pr: PrEvidence, n: number): number {
  let started = 0;
  for (let i = 0; i < n; i++) {
    upsertPr({ ...pr, observedAt: new Date().toISOString() }, OWNER);
    started += deliverPrRepairs(() => {}, 3, stillFailing);
  }
  return started;
}

/** Finish the repair in flight, as its worker would. */
function finishRepair(gates: string[] = []): string {
  const id = readPr(KEY)!.repair!.dispatchId!;
  if (gates.length) recordReportedGates(id, 'chore', gates, URL);
  appendStatus(id, 'chore', 'done', 'checked');
  return id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-human-gate-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
  config();
  owner();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

describe('human gates in the daemon repair path', () => {
  it('a PR whose only red check is a human gate gets at most one repair dispatch', () => {
    expect(observeAndRepair(red([GATE]), 2)).toBe(1);
    finishRepair();
    // Many more observations of the unchanged commit fork nothing.
    expect(observeAndRepair(red([GATE]), 6)).toBe(0);
    expect(queued()).toHaveLength(1);
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'waiting', heldBy: 'repaired', checks: [GATE] });
  });

  it('a human gate the worker records stops the next round', () => {
    expect(observeAndRepair(red([GATE]), 2)).toBe(1);
    const id = finishRepair([GATE]);
    expect(readEvidence(id, 'chore').humanGates).toEqual([GATE]);
    expect(readPr(KEY)?.humanGates).toEqual([GATE]);
    expect(observeAndRepair(red([GATE]), 3)).toBe(0);
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'waiting', heldBy: 'human-gate' });
    expect(readPr(KEY)?.repair?.reason).toContain(GATE);
    // The gate is the PR's, not the commit's: a new head forks nothing for it either.
    expect(observeAndRepair(red([GATE], NEXT), 3)).toBe(0);
    expect(queued()).toHaveLength(1);
  });

  it('a check name in the repo config never forks a repair', () => {
    config(`[repos.web]\npath = "/tmp/web"\nhumanGateChecks = ["owner *"]\n`);
    expect(observeAndRepair(red([GATE]), 5)).toBe(0);
    expect(queued()).toHaveLength(0);
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'waiting', heldBy: 'human-gate', attempts: 0 });
  });

  it('a gate beside a real failure: the repair works only on the real one and names the gate', () => {
    config(`[repos.web]\npath = "/tmp/web"\nhumanGateChecks = ["${GATE}"]\n`);
    expect(observeAndRepair(red([GATE, 'test']), 2)).toBe(1);
    const brief = queued()[0]!.brief;
    expect(brief).toContain('- test — https://ci/test');
    expect(brief).not.toContain(`- ${GATE}`);
    expect(brief).toContain(`human gates. They pass only when a person approves. Do not work on them: ${GATE}`);
    expect(brief).toContain('--human-gate');
    expect(readPr(KEY)?.repair?.checks).toEqual(['test']);
  });

  it('the floor holds on an unchanged commit and opens again for a new commit or a new check', () => {
    expect(observeAndRepair(red(['test']), 2)).toBe(1);
    finishRepair();
    expect(observeAndRepair(red(['test']), 4)).toBe(0);
    expect(readPr(KEY)?.repair?.reason).toContain(`one repair round per check and commit: test had a round at ${SHA.slice(0, 7)}`);
    // Another check fails on the same commit: it gets its own round.
    expect(observeAndRepair(red(['test', 'lint']), 1)).toBe(1);
    const latest = queued().find((d) => d.id === readPr(KEY)?.repair?.dispatchId)!;
    expect(latest.brief).toContain('- lint');
    expect(latest.brief).not.toContain('- test —');
    expect(readPr(KEY)?.repair?.checks).toEqual(['test', 'lint']);
    finishRepair();
    // The per-head limit (2) is spent. A new commit starts over.
    expect(observeAndRepair(red(['test', 'lint']), 3)).toBe(0);
    expect(observeAndRepair(red(['test'], NEXT), 2)).toBe(1);
  });

  it('a floor wait still raises checks attention; a human-gate wait does not', () => {
    stampRepairerBeat();
    expect(observeAndRepair(red(['test']), 2)).toBe(1);
    finishRepair();
    observeAndRepair(red(['test']), 1);
    expect(humanPrAttention(readPr(KEY)!, 'pr:checks', loadConfig())).toMatchObject({ show: true });
    config(`[repos.web]\npath = "/tmp/web"\nhumanGateChecks = ["${GATE}"]\n`);
    observeAndRepair(red([GATE], NEXT), 2);
    expect(readPr(KEY)?.repair?.heldBy).toBe('human-gate');
    expect(humanPrAttention(readPr(KEY)!, 'pr:checks', loadConfig())).toMatchObject({ show: false });
  });

  it('matches gate patterns exactly or with *', () => {
    expect(matchesGate('owner approval', ['owner approval'])).toBe(true);
    expect(matchesGate('owner approval (pull_request)', ['owner approval'])).toBe(false);
    expect(matchesGate('owner approval (pull_request)', ['owner approval*'])).toBe(true);
    expect(matchesGate('a.b', ['a*b'])).toBe(true);
    expect(matchesGate('axb', ['a.b'])).toBe(false);
  });

  it('the repair brief tells the worker how to name a human gate', () => {
    const brief = repairBrief({ ...red(['test']), key: KEY, repo: 'acme/web', dispatches: [], standingSince: {} }, 'checks');
    expect(brief).toContain('name it on your report with --human-gate "<check name>"');
  });
});

describe('human gates in the pick continuation path', () => {
  const failed = (seq: string, name: string, headSha = SHA) => ({
    seq,
    kind: 'check-completed',
    name,
    conclusion: 'FAILURE',
    headSha,
    notice: false,
    summary: `${KEY} check ${name} FAILURE at ${headSha.slice(0, 7)}`,
    at: new Date().toISOString(),
  });
  const finishContinuation = () => appendStatus(readWatch(KEY)!.lastFollowUpId!, 'work', 'done', 'checked');

  beforeEach(() => config('autoRepair = false\n'));

  it('a check in the repo config never forks a continuation', () => {
    config(`autoRepair = false\n[repos.web]\npath = "/tmp/web"\nhumanGateChecks = ["${GATE}"]\n`);
    appendWatchEvents(KEY, [failed('1', GATE)]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(0);
    expect(readWatch(KEY)?.seen).toBe(1);
  });

  it('a human gate the worker records stops the next continuation', () => {
    upsertPr(red([GATE]), OWNER);
    appendWatchEvents(KEY, [failed('1', GATE)]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(1);
    recordReportedGates(readWatch(KEY)!.lastFollowUpId!, 'work', [GATE], URL);
    finishContinuation();
    // The gate re-runs on a new commit and fails again: nothing forks.
    appendWatchEvents(KEY, [failed('2', GATE, NEXT)]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(1);
  });

  it('the floor holds when the same check fails again on an unchanged commit', () => {
    appendWatchEvents(KEY, [failed('1', 'test')]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(1);
    expect(readWatch(KEY)?.checkRounds).toEqual([`${SHA}:test`]);
    finishContinuation();
    for (const seq of ['2', '3', '4']) {
      appendWatchEvents(KEY, [failed(seq, 'test')]);
      deliverDispatchOwned(() => {});
    }
    expect(queued()).toHaveLength(1);
    // A new commit is a new round.
    appendWatchEvents(KEY, [failed('5', 'test', NEXT)]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(2);
  });

  it('other events of a batch still fork when a gate is filtered out', () => {
    config(`autoRepair = false\n[repos.web]\npath = "/tmp/web"\nhumanGateChecks = ["${GATE}"]\n`);
    appendWatchEvents(KEY, [failed('1', GATE), failed('2', 'test')]);
    deliverDispatchOwned(() => {});
    expect(queued()).toHaveLength(1);
    expect(queued()[0]!.brief).toContain('check test FAILURE');
    expect(queued()[0]!.brief).not.toContain(`check ${GATE} FAILURE`);
  });
});
