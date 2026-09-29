import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimNext, enqueue, ensureLayout, laneDirs, readEvidence, readWatch } from '@lobstah/core';
import { checkpointAllowed, keepRemote } from '../src/remote.js';
import { main } from '../src/run.js';

let root: string;
let previousPath: string | undefined;
const id = '33333333-3333-3333-3333-333333333333';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-remote-'));
  previousPath = process.env.PATH;
  process.env.LOBSTAH_HOME = path.join(root, 'home');
  ensureLayout();
});
afterEach(() => {
  process.env.PATH = previousPath;
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

function repo(): { dir: string; bare: string } {
  const bare = path.join(root, 'origin.git');
  const dir = path.join(root, 'repo');
  fs.mkdirSync(bare);
  git(bare, 'init', '--bare');
  git(root, 'clone', bare, dir);
  git(dir, 'config', 'user.name', 'Test Worker');
  git(dir, 'config', 'user.email', 'worker@example.test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'start\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'initial');
  git(dir, 'branch', '-M', 'main');
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'lobstah/test');
  return { dir, bare };
}

describe('headless remote preservation', () => {
  it('never checkpoints secret/build paths', () => {
    expect(checkpointAllowed('src/change.ts')).toBe(true);
    expect(checkpointAllowed('nested/.env.local')).toBe(false);
    expect(checkpointAllowed('dist/bundle.js')).toBe(false);
    expect(checkpointAllowed('cert.pem')).toBe(false);
  });

  it('checkpoints eligible files, pushes the branch, and adopts a stubbed draft PR', async () => {
    const { dir, bare } = repo();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const gh = path.join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    const calls = path.join(root, 'gh-calls');
    if (process.platform === 'win32') {
      fs.writeFileSync(gh, `@echo off\r\necho %* >> "${calls}"\r\nif "%2"=="view" exit /b 1\r\necho https://github.com/example/repo/pull/7\r\n`);
    } else {
      fs.writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$2" = "view" ]; then exit 1; fi\necho https://github.com/example/repo/pull/7\n`);
      fs.chmodSync(gh, 0o755);
    }
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'TOKEN=secret\n');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true }, intervalMs: 1000 });
    const saved = await remote.saveBeforeStop();
    expect(saved).toContain('checkpoint committed');
    expect(saved).toContain('draft PR https://github.com/example/repo/pull/7');
    expect(readEvidence(id, 'work').prUrl).toBe('https://github.com/example/repo/pull/7');
    expect(fs.readFileSync(calls, 'utf8').split('\n').filter((line) => line.includes('pr create'))).toHaveLength(1);
    const files = git(dir, 'show', '--pretty=', '--name-only', 'HEAD').split('\n');
    expect(files).toContain('README.md');
    expect(files).toContain('new.ts');
    expect(files).not.toContain('.env.local');
    expect(git(bare, 'rev-parse', 'refs/heads/lobstah/test')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it.skipIf(process.platform === 'win32')('keeps a chain PR on another head branch without pushing or creating a draft, including on stop', async () => {
    const { dir, bare } = repo();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(root, 'gh-calls');
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexit 1\n`);
    fs.chmodSync(gh, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    fs.writeFileSync(path.join(dir, 'change.ts'), 'export const changed = true;\n');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Repair',
      existingPrUrl: 'https://github.com/example/repo/pull/17',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true }, intervalMs: 1000 });
    const saved = await remote.saveBeforeStop();
    expect(saved).toContain('checkpoint committed');
    expect(saved).toContain('existing PR https://github.com/example/repo/pull/17');
    expect(readEvidence(id, 'work').prUrl).toBe('https://github.com/example/repo/pull/17');
    expect(readWatch('pr:example/repo#17')?.key).toBe('pr:example/repo#17');
    expect(git(bare, 'branch', '--list', 'lobstah/test')).toBe('');
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').not.toContain('pr create');
    await remote.stop();
    expect(git(bare, 'branch', '--list', 'lobstah/test')).toBe('');
  });

  it('does not retry or force-push a rebased follow-up over a non-fast-forward PR branch', async () => {
    const { dir, bare } = repo();
    fs.writeFileSync(path.join(dir, 'local.txt'), 'rebased work\n');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-m', 'rebased repair');
    const rival = path.join(root, 'rival');
    git(root, 'clone', bare, rival);
    git(rival, 'config', 'user.name', 'Rival');
    git(rival, 'config', 'user.email', 'rival@example.test');
    git(rival, 'switch', '-c', 'feature/pr');
    fs.writeFileSync(path.join(rival, 'rival.txt'), 'remote head\n');
    git(rival, 'add', 'rival.txt');
    git(rival, 'commit', '-m', 'advanced PR');
    git(rival, 'push', 'origin', 'feature/pr');
    const remoteHead = git(bare, 'rev-parse', 'refs/heads/feature/pr');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Repair',
      existingPrUrl: 'https://github.com/example/repo/pull/17',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: false }, intervalMs: 1000 });
    await remote.stop();
    await remote.saveBeforeStop();
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(remoteHead);
    expect(git(bare, 'branch', '--list', 'lobstah/test')).toBe('');
    expect(readEvidence(id, 'work').note).not.toContain('push rejected');
  });

  it('does not checkpoint or push on trunk', async () => {
    const { dir, bare } = repo();
    git(dir, 'switch', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'unsafe on trunk\n');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true }, intervalMs: 1000 });
    expect(await remote.saveBeforeStop()).toContain('checkpoint skipped: detached or trunk');
    expect(git(dir, 'status', '--porcelain')).toContain('README.md');
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('records a rejected non-fast-forward push with Git stderr and waits for a new HEAD', async () => {
    const { dir, bare } = repo();
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-m', 'local');
    const rival = path.join(root, 'rival');
    git(root, 'clone', bare, rival);
    git(rival, 'config', 'user.name', 'Rival');
    git(rival, 'config', 'user.email', 'rival@example.test');
    git(rival, 'switch', '-c', 'lobstah/test');
    fs.writeFileSync(path.join(rival, 'rival.txt'), 'remote\n');
    git(rival, 'add', 'rival.txt');
    git(rival, 'commit', '-m', 'remote');
    git(rival, 'push', 'origin', 'lobstah/test');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: false, checkpointOnStop: false } });
    await remote.stop();
    const note = readEvidence(id, 'work').note ?? '';
    expect(note).toContain('push rejected');
    expect(note).toMatch(/rejected|fetch first|non-fast-forward/i);
    await remote.stop();
    expect(readEvidence(id, 'work').note).toBe(note);
    git(dir, 'fetch', 'origin');
    git(dir, 'rebase', 'origin/lobstah/test'); // a new HEAD can now fast-forward the branch
    await remote.stop();
    expect(git(bare, 'rev-parse', 'refs/heads/lobstah/test')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('records a missing origin once instead of silently skipping the push', async () => {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-m', 'local');
    git(dir, 'remote', 'remove', 'origin');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: false, checkpointOnStop: false } });
    const saved = await remote.saveBeforeStop();
    expect(saved).toContain('push rejected');
    expect(saved).toMatch(/origin.*does not appear|not a git repository/i);
    const note = readEvidence(id, 'work').note;
    await remote.stop();
    expect(readEvidence(id, 'work').note).toBe(note);
  });

  it('with all remote flags false leaves commits and working files local', async () => {
    const { dir, bare } = repo();
    fs.writeFileSync(path.join(dir, 'README.md'), 'unstaged\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: false, draftPr: false, checkpointOnStop: false } });
    await remote.stop();
    await remote.saveBeforeStop();
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toContain('README.md');
    expect(git(bare, 'branch', '--list', 'lobstah/test')).toBe('');
    expect(readEvidence(id, 'work').prUrl).toBeUndefined();
  });

  it('on detached HEAD leaves files uncommitted and records why', async () => {
    const { dir } = repo();
    git(dir, 'checkout', '--detach');
    fs.writeFileSync(path.join(dir, 'README.md'), 'detached edit\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true } });
    await remote.saveBeforeStop();
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toContain('README.md');
    expect(readEvidence(id, 'work').note).toContain('detached or trunk; files left in place');
  });

  it('pushes even when gh cannot authenticate, but creates no PR', async () => {
    const { dir, bare } = repo();
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-m', 'local');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const gh = path.join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    if (process.platform === 'win32') fs.writeFileSync(gh, '@echo off\r\necho authentication required 1>&2\r\nexit /b 1\r\n');
    else { fs.writeFileSync(gh, '#!/bin/sh\necho authentication required >&2\nexit 1\n'); fs.chmodSync(gh, 0o755); }
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: false } });
    await remote.saveBeforeStop();
    expect(git(bare, 'rev-parse', 'refs/heads/lobstah/test')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(readEvidence(id, 'work').prUrl).toBeUndefined();
    expect(readEvidence(id, 'work').note).toContain('draft PR unavailable: authentication required');
  });

  it('refuses push and checkpoint for a trap-claimed dispatch', async () => {
    const { dir, bare } = repo();
    fs.writeFileSync(path.join(dir, 'README.md'), 'trap edit\n');
    const active = path.join(laneDirs('work').active, id);
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'claim.json'), JSON.stringify({ by: 'wt:test' }));
    const head = git(dir, 'rev-parse', 'HEAD');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true } });
    expect(await remote.saveBeforeStop()).toContain('trap-claimed');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toContain('README.md');
    expect(git(bare, 'branch', '--list', 'lobstah/test')).toBe('');
  });

  it('never starts a headless runner or time window for a trap catch', async () => {
    enqueue({ id, repo: 'r', brief: 'trap work' });
    claimNext('work');
    const active = path.join(laneDirs('work').active, id);
    fs.writeFileSync(path.join(active, 'claim.json'), JSON.stringify({ by: 'wt:test' }));
    await expect(main(active, 'work')).rejects.toThrow('refusing headless runner for trap catch');
    expect(fs.existsSync(path.join(active, 'runner.json'))).toBe(false);
    expect(fs.existsSync(path.join(active, 'wallclock.json'))).toBe(false);
  });
});
