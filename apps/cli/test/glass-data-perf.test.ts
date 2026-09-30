import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendStatus, enqueue, ensureLayout, laneDirs, mergeEvidence } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { clearGitCache, livenessView } from '../src/liveness-view.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * /data stays cheap. The snapshot asked git three times per dispatch with a
 * worktree, twice per snapshot, on every poll: most of /data's time on a real
 * home. The answers are now kept until the worktree's reflog moves, and the
 * built server answers /data from a thread of its own.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-perf-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  clearGitCache();
});
afterEach(() => {
  clearGitCache();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A done dispatch whose evidence names a worktree. */
function doneDispatch(id: string, worktree: string): void {
  enqueue({ id, repo: 'web', brief: 'b' });
  const done = path.join(laneDirs('work').done, id);
  fs.mkdirSync(done, { recursive: true });
  fs.renameSync(path.join(laneDirs('work').queue, `${id}.json`), path.join(done, 'descriptor.json'));
  appendStatus(id, 'work', 'done', 'finished');
  mergeEvidence(id, 'work', { worktree });
}

describe('the snapshot asks git once per worktree', () => {
  // A `#!/bin/sh` git on PATH that logs each call: POSIX only.
  it.skipIf(process.platform === 'win32')('two snapshots of 20 worktrees spawn git at most 3 times per worktree in all', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = '${home}'\ntrunk = "main"\n`);
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(home, 'git.log');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(log)}\necho main\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    for (let i = 0; i < 20; i++) {
      const wt = path.join(home, 'wts', `w${i}`);
      fs.mkdirSync(path.join(wt, '.git', 'logs'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(wt, '.git', 'logs', 'HEAD'), 'x\n');
      doneDispatch(`0000000${String(i).padStart(1, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`, wt);
    }
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const first = buildGlassSnapshot();
      const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
      const afterFirst = calls();
      expect(first.dispatches.filter((d) => d.branch === 'main')).toHaveLength(20);
      // Branch, last commit, and commits ahead: once each, though the rows and tend both ask.
      expect(afterFirst).toBeLessThanOrEqual(20 * 3);
      buildGlassSnapshot();
      expect(calls()).toBe(afterFirst);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('a new commit in the worktree shows at once', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = '${home}'\ntrunk = "main"\n`);
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt);
    git(wt, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a');
    git(wt, 'add', 'a.txt');
    git(wt, 'commit', '-q', '-m', 'first');
    const id = '11111111-0000-4000-8000-000000000001';
    doneDispatch(id, wt);
    expect(livenessView(id, 'work').lastCommit).toMatch(/ first$/);
    expect(livenessView(id, 'work').lastCommit).toMatch(/ first$/);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'second');
    expect(livenessView(id, 'work').lastCommit).toMatch(/ second$/);
  });
});

describe('the built glass answers /data from its snapshot thread', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('serves the snapshot with the page token; concurrent requests share one build; GET / answers', async () => {
    // The built module finds its worker file beside it; the source under test does not.
    const built = fileURLToPath(new URL('../dist/glass.js', import.meta.url));
    const { serveGlass } = (await import(built)) as typeof import('../src/glass.js');
    enqueue({ id: '22222222-0000-4000-8000-000000000002', repo: 'web', brief: 'b' });
    server = serveGlass(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [a, b, c, page] = await Promise.all([
      fetch(`${base}/data`).then((r) => r.text()),
      fetch(`${base}/data`).then((r) => r.text()),
      fetch(`${base}/data`).then((r) => r.text()),
      fetch(`${base}/`).then((r) => r.status),
    ]);
    expect(page).toBe(200);
    const d = JSON.parse(a) as { focusToken: string; dispatches: Array<{ id: string }> };
    expect(d.focusToken).toMatch(/^[0-9a-f]{64}$/);
    expect(d.dispatches.map((x) => x.id)).toContain('22222222-0000-4000-8000-000000000002');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
