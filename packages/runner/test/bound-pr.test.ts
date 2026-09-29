import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, laneDirs, mergeEvidence } from '@lobstah/core';
import type { Descriptor } from '@lobstah/core';
import { boundPr } from '../src/run.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-bound-pr-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('boundPr: the existing PR a dispatch works on', () => {
  it('a rebase chore with no chain is bound to the PR its descriptor names', () => {
    const d: Descriptor = { id: 'c1', repo: 'r', brief: 'rebase', pr: { url: 'https://github.com/o/r/pull/4', headRefName: 'feature/x', headSha: 'abc' } };
    expect(boundPr(d, 'chore')).toEqual({ url: 'https://github.com/o/r/pull/4', headRefName: 'feature/x' });
  });

  it('a follow-up is bound to its chain PR; new work is bound to none', () => {
    const origin = 'aaaaaaaa-0000-0000-0000-000000000000';
    const done = path.join(laneDirs('work').done, origin);
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: origin, repo: 'r', brief: 'b' }));
    mergeEvidence(origin, 'work', { prUrl: 'https://github.com/o/r/pull/5', branch: 'lobstah/aaaa' });
    expect(boundPr({ id: 'f1', repo: 'r', brief: 'b', followUp: origin }, 'work')).toEqual({ url: 'https://github.com/o/r/pull/5', headRefName: 'lobstah/aaaa' });
    expect(boundPr({ id: 'n1', repo: 'r', brief: 'b' }, 'work')).toBeUndefined();
  });
});
