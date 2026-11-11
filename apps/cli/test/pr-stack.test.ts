import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stackPrUrls } from '../src/pr-stack.js';
import type { StackRun } from '../src/pr-stack.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-stack-'));
  process.env.LOBSTAH_HOME = path.join(dir, 'home');
  execFileSync('git', ['init', '-q', '-b', 'main', path.join(dir, 'repo')]);
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

/** gh-stack's state file in the checkout's git dir. */
function ghStack(stacks: number[][]): void {
  const state = {
    schemaVersion: 1,
    stacks: stacks.map((ns) => ({ branches: ns.map((n) => ({ branch: `b${n}`, pullRequest: { number: n, url: pr(n) } })) })),
  };
  fs.writeFileSync(path.join(dir, 'repo', '.git', 'gh-stack'), JSON.stringify(state));
}

describe('the PRs a report --pr records', () => {
  it('the gh stack that holds a reported PR adds its other PRs, bottom to top', () => {
    ghStack([
      [1, 2],
      [10, 11, 12],
    ]);
    const cwd = path.join(dir, 'repo');
    expect(stackPrUrls([pr(11)], { cwd })).toEqual([pr(11), pr(10), pr(12)]);
    expect(stackPrUrls([pr(99)], { cwd })).toEqual([pr(99)]);
  });

  it('repeated PRs are kept in order, one per PR; a non-PR URL is dropped', () => {
    const cwd = path.join(dir, 'repo');
    expect(stackPrUrls([pr(3), `${pr(4)}/files`, pr(3), 'https://example.com/x'], { cwd })).toEqual([pr(3), pr(4)]);
    expect(stackPrUrls([], { cwd })).toEqual([]);
  });

  it("a base chain of the dispatch's branches adds the PRs linked to the reported one", () => {
    // b1 on main, b2 on b1, b3 on b2; b9 is another PR on main.
    const views: Record<string, { url: string; headRefName: string; baseRefName: string }> = {
      b1: { url: pr(1), headRefName: 'b1', baseRefName: 'main' },
      b2: { url: pr(2), headRefName: 'b2', baseRefName: 'b1' },
      b3: { url: pr(3), headRefName: 'b3', baseRefName: 'b2' },
      b9: { url: pr(9), headRefName: 'b9', baseRefName: 'main' },
    };
    const asked: string[] = [];
    const run: StackRun = (cmd, args) => {
      if (cmd === 'git') return { status: 1, stdout: '' };
      asked.push(args[2]!);
      const v = views[args[2]!];
      return v ? { status: 0, stdout: JSON.stringify(v) } : { status: 1, stdout: '' };
    };
    expect(stackPrUrls([pr(2)], { cwd: dir, branches: ['b3', 'b1', 'b2', 'b9', 'gone'], run })).toEqual([pr(2), pr(1), pr(3), pr(9)]);
    expect(asked).toEqual(['b3', 'b1', 'b2', 'b9', 'gone']);
    // One branch: no chain, and no gh.
    asked.length = 0;
    expect(stackPrUrls([pr(2)], { cwd: dir, branches: ['b2'], run })).toEqual([pr(2)]);
    expect(asked).toEqual([]);
  });

  it('never throws', () => {
    const run: StackRun = () => {
      throw new Error('spawn failed');
    };
    expect(stackPrUrls([pr(1)], { cwd: dir, branches: ['a', 'b'], run })).toEqual([pr(1)]);
  });
});

it('persists one-based stack positions and every PR watch even after bases change', async () => {
  const { dispatchPrDiscovery, recordDispatchPrs } = await import('../src/pr-stack.js');
  const { enqueue, ensureLayout, readEvidence, readWatch, dispatchPrLines } = await import('@lobstah/core');
  ensureLayout(); enqueue({ id: 'stack-dispatch', repo: 'web', brief: 'stack' });
  ghStack([[1, 2, 3]]);
  const discovered = dispatchPrDiscovery([pr(3)], { cwd: path.join(dir, 'repo') });
  recordDispatchPrs('stack-dispatch', 'work', discovered, true);
  const evidence = readEvidence('stack-dispatch', 'work');
  expect(evidence.prUrl).toBe(pr(3));
  expect(evidence.prPositions?.[pr(2)]).toEqual({ bottom: pr(1), position: 2, size: 3 });
  for (const number of [1, 2, 3]) expect(readWatch(`pr:o/r#${number}`)?.owner).toBe('dispatch:stack-dispatch');
  recordDispatchPrs('stack-dispatch', 'work', { urls: [pr(2)], positions: {} }, true);
  expect(dispatchPrLines(readEvidence('stack-dispatch', 'work'))).toEqual([`PR 1/3: ${pr(1)}`, `PR 2/3: ${pr(2)}`, `PR 3/3: ${pr(3)}`]);
});

it('the normal PR watch backfills a whole owned stack into dispatch evidence and watches', async () => {
  const { ensureLayout, enqueue, parsePrRef, readEvidence, readPr, readWatch, mergeEvidence } = await import('@lobstah/core');
  const { observePr } = await import('../src/pr-watch.js');
  const { discoverPrStack } = await import('../src/pr-stack-watch.js');
  ensureLayout(); enqueue({ id: 'watched-stack', repo: 'web', brief: 'stack' });
  const view = (number: number) => ({
    url: pr(number), number, state: 'OPEN', isDraft: false, headRefOid: `sha${number}`,
    headRefName: `b${number}`, baseRefName: number === 1 ? 'main' : `b${number - 1}`,
    isCrossRepository: false, author: { login: 'bot' }, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [],
  });
  mergeEvidence('watched-stack', 'work', { prUrl: pr(3) });
  observePr(parsePrRef(pr(3))!, view(3), { dispatchId: 'watched-stack' });
  expect(readPr('pr:o/r#3')?.dispatches).toContain('watched-stack');
  discoverPrStack(parsePrRef(pr(3))!, { viewer: () => 'bot', fetch: (_ref, branch, direction) => {
    const number = direction === 'head' ? Number(branch.slice(1)) : Number(branch.slice(1)) + 1;
    return number >= 1 && number <= 3 ? [view(number)] : [];
  } });
  const evidence = readEvidence('watched-stack', 'work');
  expect(evidence.prUrls).toEqual([pr(3), pr(1), pr(2)]);
  for (const number of [1, 2, 3]) {
    expect(evidence.prPositions?.[pr(number)]).toMatchObject({ position: number, size: 3 });
    expect(readWatch(`pr:o/r#${number}`)?.owner).toBe('dispatch:watched-stack');
    expect(readPr(`pr:o/r#${number}`)?.dispatches).toContain('watched-stack');
  }
});

it('records all pushed stack branches beyond the old twelve-branch limit', async () => {
  const { dispatchPrDiscovery } = await import('../src/pr-stack.js');
  const branches = Array.from({ length: 17 }, (_, index) => `b${index + 1}`);
  const run: StackRun = (command, args) => {
    if (command !== 'gh') return { status: 1, stdout: '' };
    const number = Number(args[2]!.slice(1));
    return { status: 0, stdout: JSON.stringify({ url: pr(number), headRefName: `b${number}`, baseRefName: number === 1 ? 'main' : `b${number - 1}` }) };
  };
  const discovery = dispatchPrDiscovery([pr(17)], { cwd: dir, branches, run });
  expect(discovery.urls).toHaveLength(17);
  expect(discovery.positions[pr(16)]).toEqual({ bottom: pr(1), position: 16, size: 17 });
});
