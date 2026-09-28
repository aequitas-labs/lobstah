import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout, laneDirs, mergeEvidence, statusPath } from '@lobstah/core';
import { cliCuller } from '../src/auto-cull.js';
import { planCull, planPressureCull } from '../src/cull.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { buildTendReport } from '../src/tend.js';

/**
 * A follow-up that reused its origin's worktree: the cull and the
 * free-space guard keep the shared checkout while any chain member is
 * queued or active and age it from the newest user, and catch, tend, and
 * the glass resolve the follow-up to the checkout it ran in.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const DAY = 86_400_000;
let home: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

const wtOf = (id: string) => path.join(home, 'worktrees', id);

/** A finished dispatch. `reused` names the dispatch whose worktree it ran in. */
function finished(id: string, days: number, opts: { followUp?: string; reused?: string } = {}): void {
  if (!opts.reused) {
    git(repo, 'worktree', 'add', '-q', '-b', `lobstah/${id}`, wtOf(id));
    age(wtOf(id), days);
  }
  enqueue({ id, repo: 'r', brief: 'b', ...(opts.followUp ? { followUp: opts.followUp } : {}) });
  expect(claimNext('work')).toBe(id);
  const wt = wtOf(opts.reused ?? id);
  fs.writeFileSync(
    path.join(laneDirs('work').active, id, 'worktree.json'),
    JSON.stringify(opts.reused ? { path: wt, of: opts.reused } : { path: wt }),
  );
  mergeEvidence(id, 'work', { worktree: wt, ...(opts.reused ? { worktreeOf: opts.reused } : {}), branch: `lobstah/${opts.reused ?? id}` });
  appendStatus(id, 'work', 'done', 'finished');
  fs.renameSync(path.join(laneDirs('work').active, id), path.join(laneDirs('work').done, id));
  age(path.join(laneDirs('work').done, id), days);
  age(statusPath(id, 'work'), days);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wt-reuse-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\n`);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const worktreeItems = (items: { kind: string; id: string }[]) => items.filter((i) => i.kind === 'worktree').map((i) => i.id);

describe('a shared worktree in the cull and the free-space guard', () => {
  it('ages from the newest dispatch that used it', () => {
    finished('origin', 30);
    finished('fu', 1, { followUp: 'origin', reused: 'origin' });
    // The origin's own done entry is old enough to cull; its worktree is not.
    const plan = planCull(14, Date.now(), { measure: false });
    expect(plan.some((i) => i.kind === 'done' && i.id === 'origin')).toBe(true);
    expect(worktreeItems(plan)).not.toContain('origin');

    // Every user finished: the pressure cull may take it, aged from the follow-up.
    const pressure = planPressureCull();
    expect(pressure.find((i) => i.id === 'origin')?.ageDays).toBe(1);

    // Once the newest user is old too, retention takes it.
    age(path.join(laneDirs('work').done, 'fu'), 20);
    expect(worktreeItems(planCull(14, Date.now(), { measure: false }))).toContain('origin');
  });

  it('is never removed while a queued chain member may still reuse it', () => {
    finished('origin', 30);
    finished('fu', 30, { followUp: 'origin', reused: 'origin' });
    enqueue({ id: 'queued', repo: 'r', brief: 'b', followUp: 'fu' });
    expect(worktreeItems(planCull(14, Date.now(), { measure: false }))).not.toContain('origin');
    expect(worktreeItems(planPressureCull())).not.toContain('origin');
    cliCuller.pressure(() => false, Date.now(), 10, () => {});
    cliCuller.retention(14, Date.now(), 10, () => {});
    expect(fs.existsSync(wtOf('origin'))).toBe(true);
  });

  it('is never removed while an active chain member runs in it', () => {
    finished('origin', 30);
    enqueue({ id: 'running', repo: 'r', brief: 'b', followUp: 'origin' });
    expect(claimNext('work')).toBe('running');
    fs.writeFileSync(path.join(laneDirs('work').active, 'running', 'worktree.json'), JSON.stringify({ path: wtOf('origin'), of: 'origin' }));
    expect(worktreeItems(planCull(14, Date.now(), { measure: false }))).not.toContain('origin');
    expect(worktreeItems(planPressureCull())).not.toContain('origin');
    cliCuller.pressure(() => false, Date.now(), 10, () => {});
    cliCuller.retention(14, Date.now(), 10, () => {});
    expect(fs.existsSync(wtOf('origin'))).toBe(true);
  });

  it('is removed through git even after the owner’s done entry was culled', () => {
    finished('origin', 30);
    finished('fu', 20, { followUp: 'origin', reused: 'origin' });
    fs.rmSync(path.join(laneDirs('work').done, 'origin'), { recursive: true });
    cliCuller.retention(14, Date.now(), 10, () => {});
    expect(fs.existsSync(wtOf('origin'))).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('origin');
    expect(git(repo, 'branch', '--list', 'lobstah/origin')).toContain('lobstah/origin');
  });
});

describe('catch, tend, and the glass resolve a reused follow-up', () => {
  it('shows the origin’s checkout for the follow-up', () => {
    finished('origin', 0);
    enqueue({ id: 'fu', repo: 'r', brief: 'b', followUp: 'origin' });
    expect(claimNext('work')).toBe('fu');
    fs.writeFileSync(path.join(laneDirs('work').active, 'fu', 'worktree.json'), JSON.stringify({ path: wtOf('origin'), of: 'origin' }));
    mergeEvidence('fu', 'work', { worktree: wtOf('origin'), worktreeOf: 'origin' });
    appendStatus('fu', 'work', 'working', 'reusing worktree of origin');

    const caught = lobstah('catch', 'fu');
    expect(caught.stdout).toContain(`worktree: ${wtOf('origin')}`);
    expect(caught.stdout).toContain('worktreeOf: origin');

    const t = buildTendReport()
      .stories.flatMap((s) => s.dispatches)
      .find((x) => x.id === 'fu');
    expect(t).toMatchObject({ worktree: wtOf('origin'), worktreeOf: 'origin' });

    const g = buildGlassSnapshot().dispatches.find((x) => x.id === 'fu');
    expect(g).toMatchObject({ worktree: wtOf('origin'), worktreeOf: 'origin' });

    // attach opens the session in the checkout it ran in.
    mergeEvidence('fu', 'work', { sessionId: '19a4f6e4-1341-4c3a-9f2e-0123456789ab', harness: 'claude' });
    appendStatus('fu', 'work', 'done', 'finished');
    const attach = lobstah('attach', 'fu', '--print');
    expect(attach.stdout).toContain(`cwd: ${wtOf('origin')}`);
  });
});
