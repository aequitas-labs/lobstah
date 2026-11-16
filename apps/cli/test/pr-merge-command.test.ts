import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, readPr, readWatch, upsertPr } from '@lobstah/core';
import { mergeWhenGreenCommand } from '../src/pr-merge-command.js';
import { parseArgs } from '../src/usage.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-command-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.lobstah]\npath="/missing"\norigin="git@github.com:acme/lobstah.git"\nmergeMethod="merge"\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
const key = 'pr:acme/lobstah#7';
const methods = () => ({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
function command(args: string[]) {
  const parsed = parseArgs('pr', ['merge-when-green', ...args])!;
  if (parsed.error) throw new Error(parsed.error);
  return mergeWhenGreenCommand(parsed.positionals, {
    opt: name => { const v = parsed.flags.get(name); return typeof v === 'string' ? v : undefined; },
    has: name => parsed.flags.has(name),
  }, { methods, observe: ref => { upsertPr({ url: ref.url, number: ref.number, state: 'OPEN', draft: false,
    reviewDecision: '', mergeStateStatus: 'CLEAN', headSha: 'head', baseRefName: 'main', headRefName: 'feature',
    author: 'other-person', observedAt: new Date().toISOString(), checks: { total: 1, passed: 1, failed: 0, pending: 0 } }); } });
}

describe('pr merge-when-green', () => {
  it('records an explicit decision, watches a previously unseen PR, and lists the authorization in tend', () => {
    expect(command(['acme/lobstah#7', '--by', 'decision:deploy', '--hold', 'Finish DB steps', '--note', 'Staging and production'])).toContain('held: Finish DB steps');
    const request = readPr(key)!.mergeRequest!;
    expect(request).toMatchObject({ by: 'decision:deploy', method: 'merge', hold: 'Finish DB steps', note: 'Staging and production' });
    expect(readWatch(key)).toBeDefined();
    const tend = buildTendReport();
    expect(tend.mergeWhenGreen).toEqual([expect.objectContaining({ pr: key, by: 'decision:deploy', hold: 'Finish DB steps' })]);
    expect(renderTend(tend)).toContain('merge when green');
    command(['--release-hold', 'acme/lobstah#7']);
    expect(readPr(key)!.mergeRequest).toMatchObject({ by: 'decision:deploy', at: request.at, method: 'merge' });
    expect(readPr(key)!.mergeRequest!.hold).toBeUndefined();
    command(['--clear', 'acme/lobstah#7']);
    expect(readPr(key)!.mergeRequest).toBeUndefined();
  });

  it('defaults to chat and accepts an explicit allowed method', () => {
    command(['acme/lobstah#7', '--method', 'squash']);
    expect(readPr(key)!.mergeRequest).toMatchObject({ by: 'chat', method: 'squash' });
  });

  it.each([
    ['acme/lobstah#7', '--by', 'someone'],
    ['acme/lobstah#7', '--method', 'rebase'],
    ['acme/lobstah#7', '--hold', 'DB', '--release-hold'],
    ['acme/lobstah#7', '--clear', '--note', 'oops'],
    ['acme/lobstah#7', '--release-hold'],
  ])('rejects invalid arguments %j without creating authorization', (...args) => {
    expect(() => command(args)).toThrow();
    expect(readPr(key)?.mergeRequest).toBeUndefined();
  });

  it('refuses a method disabled by the repository', () => {
    expect(() => mergeWhenGreenCommand(['merge-when-green', 'acme/lobstah#7'], { opt: () => undefined, has: () => false }, {
      methods: () => ({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false }),
    })).toThrow('does not allow merge');
  });
});
