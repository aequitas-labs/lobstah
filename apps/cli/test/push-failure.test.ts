import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  appendStatus,
  ensureLayout,
  laneDirs,
  listNotices,
  mergeEvidence,
  readPr,
  repairBrief,
  upsertPr,
} from '@lobstah/core';
import type { Descriptor, PrEvidence } from '@lobstah/core';
import { deliverPrRepairs, recordPushFailure } from '../src/pr-repair.js';
import { rebaseBrief } from '../../pick/src/loops/merge.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MOVED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const URL = 'https://github.com/acme/web/pull/17';
const KEY = 'pr:acme/web#17';
const REJECTION = ' ! [rejected]        HEAD -> feature/pr (non-fast-forward)';
let home: string;

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: URL,
  number: 17,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'DIRTY',
  headSha: SHA,
  baseRefName: 'main',
  headRefName: 'feature/pr',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: new Date().toISOString(),
  ...over,
});

function queued(): Descriptor[] {
  return fs
    .readdirSync(laneDirs('chore').queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('chore').queue, f), 'utf8')) as Descriptor);
}

/** A dispatch-owned PR with one conflict repair queued: the repair's descriptor. */
function queuedRepair(): Descriptor {
  const done = path.join(laneDirs('work').done, OWNER);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: OWNER, repo: 'web', brief: 'make PR' } satisfies Descriptor));
  appendStatus(OWNER, 'work', 'done', 'PR sent');
  mergeEvidence(OWNER, 'work', { commits: [SHA] });
  addWatch(KEY, 'echo {}', { owner: `dispatch:${OWNER}` });
  upsertPr(pr(), OWNER);
  upsertPr(pr(), OWNER);
  expect(deliverPrRepairs(() => {}, 3)).toBe(1);
  return queued()[0]!;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-push-failure-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[watch]\nrepairSettleSecs = 0\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a repair that cannot push', () => {
  it('marks the PR record at the moved head, posts one notice, and starts no new round on either head', () => {
    const repair = queuedRepair();
    const note = `push rejected: ${REJECTION}; moved head ${MOVED}`;
    appendStatus(repair.id, 'chore', 'failed', note);
    expect(recordPushFailure(repair.id, 'chore', note)).toBe(KEY);
    expect(readPr(KEY)).toMatchObject({ headSha: SHA, state: 'OPEN' }); // the PR itself is left as it was
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'blocked', headSha: MOVED, fromHeadSha: SHA, dispatchId: repair.id });
    expect(readPr(KEY)?.repair?.reason).toContain('non-fast-forward');
    expect(listNotices().filter((n) => n.kind === 'push-failed').map((n) => n.refId)).toEqual([repair.id]);

    expect(deliverPrRepairs(() => {}, 3)).toBe(0); // the head it started from
    upsertPr(pr({ headSha: MOVED }), OWNER);
    upsertPr(pr({ headSha: MOVED }), OWNER);
    expect(deliverPrRepairs(() => {}, 3)).toBe(0); // the moved head, once observed
    expect(queued().map((d) => d.id)).toEqual([repair.id]);
  });

  it('a failed report that is not a push rejection marks nothing', () => {
    const repair = queuedRepair();
    appendStatus(repair.id, 'chore', 'failed', 'could not resolve the conflict');
    expect(recordPushFailure(repair.id, 'chore', 'could not resolve the conflict')).toBeUndefined();
    expect(readPr(KEY)?.repair).toMatchObject({ status: 'repairing', headSha: SHA });
    expect(listNotices().filter((n) => n.kind === 'push-failed')).toEqual([]);
  });
});

describe('the push rule in briefs', () => {
  const rule = (branch: string, id: string) => [
    `Push only to the existing branch ${branch}.`,
    `rejected as non-fast-forward because ${branch} moved, fetch ${branch}, rebase your commits onto the moved head again, and push with \`--force-with-lease=${branch}:<the head you just fetched>\`. Retry at most 3 times.`,
    'If a push hook fails with a real test or type error, do not retry the push',
    `lobstah report ${id} failed "push rejected: <rejection text>; moved head <full sha of the head you fetched>"`,
    'leave the PR as it was',
    'Never push to another branch. Never open a new PR.',
  ];

  it('the repair brief tells the worker the rule for every repair kind', () => {
    upsertPr(pr(), OWNER);
    for (const kind of ['conflict', 'checks', 'review'] as const) {
      const brief = repairBrief(readPr(KEY)!, kind, 'repair-id');
      expect(brief).toContain("For code already on main, take main's version.");
      expect(brief).toContain("Keep only this PR's own changes.");
      expect(brief).toContain('If resolving a conflict would change code behavior, stop and report needs-decision.');
      for (const line of rule('feature/pr', 'repair-id')) expect(brief).toContain(line);
    }
  });

  it('the rebase chore brief tells the worker the same rule', () => {
    const brief = rebaseBrief(
      { number: 17, url: URL, headRef: 'feature/pr', headSha: SHA, labels: [], assignees: [], reviews: [], mergeableState: 'dirty' } as never,
      'chore-id',
    );
    for (const line of rule('feature/pr', 'chore-id')) expect(brief).toContain(line);
  });
});
