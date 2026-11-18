import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendStatus, claimNext, complete, enqueue, ensureLayout, laneDirs, readStatusLog, storedDescriptor } from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter } from '@lobstah/adapters';
import { releaseReviewWorktree, worktreePath } from '@lobstah/worktree';
import { main } from '../src/run.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-cleanup-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const origin = path.join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\n[limits]\npushEarly = false\ndraftPr = false\ncheckpointOnStop = false\n`);
});
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });

function review(id: string, readOnly = true): string {
  enqueue({ id, repo: 'r', brief: 'review this PR', readOnly }, 'chore');
  expect(claimNext('chore')).toBe(id);
  const dir = path.join(laneDirs('chore').active, id);
  const wt = worktreePath(id);
  git(repo, 'worktree', 'add', '-q', '--no-track', '-b', `lobstah/${id}`, wt, 'origin/main');
  fs.writeFileSync(path.join(dir, 'worktree.json'), JSON.stringify({ path: wt }));
  return dir;
}

function terminalAdapter(verb: 'done' | 'failed'): Adapter {
  return {
    name: 'claude',
    async start(opts) {
      const events = new AsyncQueue<NormalizedEvent>();
      const at = new Date().toISOString();
      events.push({ at, type: 'session', data: { sessionId: 'review-session' } });
      const report = path.join(laneDirs('chore').state, opts.id, 'report.md');
      fs.mkdirSync(path.dirname(report), { recursive: true });
      fs.writeFileSync(report, 'Review findings');
      appendStatus(opts.id, 'chore', verb, 'review finished');
      events.push({ at, type: 'turn-end', data: { subtype: 'success' } });
      events.close();
      return { events, send() {}, end() {}, kill() {}, done: Promise.resolve({ sessionId: 'review-session' }) };
    },
  };
}

describe('review checkout cleanup on finish', () => {
  it.each(['done', 'failed'] as const)('removes a clean %s review checkout and preserves its report, records and branch', async (verb) => {
    const dir = review('review1');
    await main(dir, 'chore', { loadAdapter: () => terminalAdapter(verb) });
    expect(fs.existsSync(worktreePath('review1'))).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('chore').done, 'review1'))).toBe(true);
    expect(storedDescriptor('review1', 'chore')?.readOnly).toBe(true);
    expect(readStatusLog('review1', 'chore').at(-1)?.verb).toBe(verb);
    expect(fs.readFileSync(path.join(laneDirs('chore').state, 'review1', 'report.md'), 'utf8')).toBe('Review findings');
    expect(git(repo, 'branch', '--list', 'lobstah/review1')).toContain('lobstah/review1');
  });

  it.each(['dirty', 'unpushed'] as const)('keeps %s work and logs why', async (kind) => {
    review('review1');
    if (kind === 'dirty') fs.writeFileSync(path.join(worktreePath('review1'), 'findings.txt'), 'unsaved work');
    else git(worktreePath('review1'), 'commit', '-q', '--allow-empty', '-m', 'local work');
    appendStatus('review1', 'chore', 'failed');
    complete('review1', 'chore');
    const logs: string[] = [];
    expect(await releaseReviewWorktree('review1', 'chore', (m) => logs.push(m))).toBe(false);
    expect(fs.existsSync(worktreePath('review1'))).toBe(true);
    expect(logs.join('\n')).toMatch(kind === 'dirty' ? /uncommitted or untracked/ : /1 unpushed commit/);
  });

  it('keeps an ordinary chore checkout', async () => {
    review('ordinary', false);
    appendStatus('ordinary', 'chore', 'done');
    complete('ordinary', 'chore');
    expect(await releaseReviewWorktree('ordinary', 'chore', () => {})).toBe(false);
    expect(fs.existsSync(worktreePath('ordinary'))).toBe(true);
  });

  it('keeps the checkout while a queued follow-up may reuse it', async () => {
    review('review1');
    appendStatus('review1', 'chore', 'done');
    complete('review1', 'chore');
    enqueue({ id: 'followup', repo: 'r', brief: 'continue', followUp: 'review1' }, 'chore');
    const logs: string[] = [];
    expect(await releaseReviewWorktree('review1', 'chore', (m) => logs.push(m))).toBe(false);
    expect(logs.join('\n')).toContain('in use by followup');
    expect(fs.existsSync(worktreePath('review1'))).toBe(true);
  });

  it('keeps a review that ran in a shared checkout', async () => {
    const dir = review('review1');
    fs.writeFileSync(path.join(dir, 'worktree.json'), JSON.stringify({ path: repo, of: 'origin' }));
    appendStatus('review1', 'chore', 'done');
    complete('review1', 'chore');
    const logs: string[] = [];
    expect(await releaseReviewWorktree('review1', 'chore', (m) => logs.push(m))).toBe(false);
    expect(logs.join('\n')).toContain('shared or externally managed');
    expect(fs.existsSync(repo)).toBe(true);
  });
});
