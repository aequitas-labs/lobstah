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
    expect(stackPrUrls([pr(2)], { cwd: dir, branches: ['b3', 'b1', 'b2', 'b9', 'gone'], run })).toEqual([pr(2), pr(1), pr(3)]);
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
