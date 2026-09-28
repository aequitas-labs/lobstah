import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureLayout, readEvidence } from '@lobstah/core';
import { checkpointAllowed, keepRemote } from '../src/remote.js';

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
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, '#!/bin/sh\nif [ "$2" = "view" ]; then exit 1; fi\necho https://github.com/example/repo/pull/7\n');
    fs.chmodSync(gh, 0o755);
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
    const files = git(dir, 'show', '--pretty=', '--name-only', 'HEAD').split('\n');
    expect(files).toContain('README.md');
    expect(files).toContain('new.ts');
    expect(files).not.toContain('.env.local');
    expect(git(bare, 'rev-parse', 'refs/heads/lobstah/test')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('does not checkpoint or push on trunk', async () => {
    const { dir, bare } = repo();
    git(dir, 'switch', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'unsafe on trunk\n');
    const remote = keepRemote({ id, lane: 'work', cwd: dir, trunk: 'main', title: 'Test dispatch',
      policy: { pushEarly: true, draftPr: true, checkpointOnStop: true }, intervalMs: 1000 });
    expect(await remote.saveBeforeStop()).toBe('checkpoint skipped: detached or trunk');
    expect(git(dir, 'status', '--porcelain')).toContain('README.md');
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });
});
