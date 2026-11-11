import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHeavyHooks, ensureLayout, heavyHooksDir, signOnTrap } from '@lobstah/core';
import { stopChildren } from '../../../test/child-process.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { isLightPush } from '../src/heavy.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const TEST_MS = 60_000;

let root: string;
let home: string;
let main: string;
let wt: string;
let bare: string;
let bin: string;
let record: string;
let priorHome: string | undefined;
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A push environment: a person's by default, an agent's with a marker. */
function pushEnv(extra: NodeJS.ProcessEnv = {}, withLobstah = true): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home, PATH: `${withLobstah ? `${bin}${path.delimiter}` : ''}${process.env.PATH}` };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCLAW_SHELL', 'LOBSTAH_HEAVY_TICKET', 'VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) delete out[k];
  return { ...out, ...extra };
}
const AGENT = { CLAUDECODE: '1' };

function push(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('git', ['push', ...args, 'origin', 'HEAD:refs/heads/topic'], { cwd: wt, env, encoding: 'utf8', timeout: 45_000 });
}

function commit(file = 'a.txt'): void {
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), String(Math.random()));
  git(wt, 'add', file);
  git(wt, 'commit', '-qm', `change ${file}`);
}

/** Husky's shape: a relative hooks path in the shared config, generated in each checkout. */
function installHook(body: string, name = 'pre-push'): void {
  const dir = path.join(wt, '.husky', '_');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  git(main, 'config', 'core.hooksPath', '.husky/_');
}

const RECORD_HOOK = () => `{
  echo "args=$*"
  echo "ticket=$LOBSTAH_HEAVY_TICKET"
  echo "forks=$VITEST_MAX_FORKS"
  echo "stdin=$(cat)"
} > ${JSON.stringify(record)}`;

const setConfig = (toml: string) => fs.writeFileSync(path.join(home, 'config.toml'), toml);
const history = () => {
  const file = path.join(home, 'heavy', 'history.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { command: string }) : [];
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-shim-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  priorHome = process.env.LOBSTAH_HOME;
  process.env.LOBSTAH_HOME = home;
  bare = path.join(root, 'bare.git');
  main = path.join(root, 'main');
  wt = path.join(root, 'wt');
  bin = path.join(root, 'bin');
  record = path.join(root, 'record');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'lobstah'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', '-q', 'origin', 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'topic', wt);
  fs.writeFileSync(path.join(wt, '.lobstah-trap'), JSON.stringify({ trapId: 'abcd1234', name: 'test-trap', repo: 'demo' }));
  commit();
});
afterEach(async () => {
  await stopChildren(children.splice(0));
  if (priorHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = priorHome;
  removeTempDir(root);
});

const remoteHas = () => spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/topic'], { cwd: bare, encoding: 'utf8' }).status === 0;

describe.skipIf(process.platform === 'win32')('the push shim', () => {
  beforeEach(() => {
    expect(applyHeavyHooks(wt)).toBe(true);
  });

  it('takes a slot, then runs the real hook with the same arguments and refs', () => {
    installHook(RECORD_HOOK());
    const run = push(pushEnv(AGENT));
    expect(run.status, run.stderr).toBe(0);
    expect(remoteHas()).toBe(true);
    const seen = fs.readFileSync(record, 'utf8');
    expect(seen).toContain(`args=origin ${bare}`);
    expect(seen).toMatch(/ticket=\d+/);
    expect(seen).toMatch(/forks=\d+/);
    expect(seen).toContain(`refs/heads/topic ${'0'.repeat(40)}`);
    expect(seen).toContain(`stdin=HEAD ${git(wt, 'rev-parse', 'HEAD')} refs/heads/topic`);
    expect(run.stderr).toContain('heavy: running, slot');
    expect(history().map((h) => h.command)).toEqual(['git push']);
  }, TEST_MS);

  it('a failing hook still stops the push, and frees its slot', () => {
    installHook('echo gate failed >&2; exit 9');
    const run = push(pushEnv(AGENT));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('gate failed');
    expect(remoteHas()).toBe(false);
    expect(fs.readdirSync(path.join(home, 'heavy', 'line'))).toEqual([]);
  }, TEST_MS);

  it('a person never waits: no agent marker, no slot', () => {
    installHook(RECORD_HOOK());
    const run = push(pushEnv());
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');
    expect(run.stderr).not.toContain('heavy:');
  }, TEST_MS);

  it('a worktree that is not lobstah\'s runs the hook straight through', () => {
    fs.rmSync(path.join(wt, '.lobstah-trap'));
    installHook(RECORD_HOOK());
    expect(push(pushEnv(AGENT)).status).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');
  }, TEST_MS);

  it('takes no slot when the repo has no pre-push hook', () => {
    const run = push(pushEnv(AGENT));
    expect(run.status, run.stderr).toBe(0);
    expect(remoteHas()).toBe(true);
    expect(run.stderr).not.toContain('heavy:');
    expect(history()).toEqual([]);
  }, TEST_MS);

  it('--no-verify behaves as it does today', () => {
    installHook('exit 9');
    const run = push(pushEnv(AGENT), '--no-verify');
    expect(run.status, run.stderr).toBe(0);
    expect(history()).toEqual([]);
  }, TEST_MS);

  it('a push under lobstah heavy takes one slot, not two', () => {
    setConfig('[heavy]\nslots = 1\n');
    installHook(RECORD_HOOK());
    const run = spawnSync(process.execPath, [cli, 'heavy', '--', 'git', 'push', 'origin', 'HEAD:refs/heads/topic'], { cwd: wt, env: pushEnv(AGENT), encoding: 'utf8', timeout: 45_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(history()).toHaveLength(1);
  }, TEST_MS);

  it('waits in line before the hook runs', async () => {
    setConfig('[heavy]\nslots = 1\n');
    installHook(RECORD_HOOK());
    const holding = path.join(root, 'holding');
    const release = path.join(root, 'release');
    const holder = spawn(process.execPath, [cli, 'heavy', '--', process.execPath, '-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(holding)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},50)`], { env: pushEnv(), cwd: root, stdio: 'ignore' });
    children.push(holder);
    while (!fs.existsSync(holding)) await new Promise((r) => setTimeout(r, 25));
    const pusher = spawn('git', ['push', 'origin', 'HEAD:refs/heads/topic'], { cwd: wt, env: pushEnv(AGENT), stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(pusher);
    let err = '';
    pusher.stderr!.on('data', (d) => (err += String(d)));
    const pushed = new Promise<number | null>((resolve) => pusher.once('close', (c) => resolve(c)));
    while (!err.includes('in line')) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(record)).toBe(false);
    expect(err).toContain('in line, 1st. Running:');
    fs.writeFileSync(release, '');
    expect(await pushed).toBe(0);
    expect(fs.existsSync(record)).toBe(true);
  }, TEST_MS);

  it('runs the hook without a slot, saying so once, when the lobstah command is missing', () => {
    installHook(RECORD_HOOK());
    const run = push({ ...pushEnv(AGENT), PATH: '/usr/bin:/bin' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr.match(/heavy:.*/g)).toEqual(["heavy: running without a slot: the lobstah command isn't available"]);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');
  }, TEST_MS);

  it('runs the hook without a slot when the lobstah command is too old to take one', () => {
    fs.writeFileSync(path.join(bin, 'lobstah'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    installHook(RECORD_HOOK());
    const run = push(pushEnv(AGENT));
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');
  }, TEST_MS);

  it('works through husky\'s own wrapper, whose real hook is found from its path', () => {
    const dir = path.join(wt, '.husky', '_');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'h'), '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\nc=$?\nexit $c\n');
    fs.writeFileSync(path.join(dir, 'pre-push'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(wt, '.husky', 'pre-push'), RECORD_HOOK());
    git(main, 'config', 'core.hooksPath', '.husky/_');
    const run = push(pushEnv(AGENT));
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toMatch(/ticket=\d+/);
    expect(fs.readFileSync(record, 'utf8')).toContain('refs/heads/topic');
  }, TEST_MS);

  it('light refs and light paths take no slot, and the hook still runs', () => {
    setConfig('[heavy.repos.demo]\nlightRefs = ["refs/heads/pr-evidence"]\nlightPaths = ["apps/design/"]\n');
    ensureLayout();
    expect(signOnTrap({ worktree: wt, cwd: wt, repo: 'demo', harness: 'claude', sessionId: 's1', ttlMs: 60_000 })).toHaveProperty('ok');
    installHook(RECORD_HOOK());

    const evidence = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/pr-evidence'], { cwd: wt, env: pushEnv(AGENT), encoding: 'utf8' });
    expect(evidence.status, evidence.stderr).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');
    expect(fs.readFileSync(record, 'utf8')).toContain('refs/heads/pr-evidence');

    git(wt, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/topic');
    commit('apps/design/page.tsx');
    expect(push(pushEnv(AGENT)).status).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toContain('ticket=\n');

    commit('apps/web/page.tsx');
    expect(push(pushEnv(AGENT)).status).toBe(0);
    expect(fs.readFileSync(record, 'utf8')).toMatch(/ticket=\d+/);
  }, TEST_MS);

  it('other hooks go straight to the real one', () => {
    installHook(`echo ran > ${JSON.stringify(record)}\nexit 3`, 'pre-commit');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'x');
    git(wt, 'add', 'b.txt');
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: wt, env: pushEnv(AGENT), encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(fs.readFileSync(record, 'utf8').trim()).toBe('ran');
    expect(history()).toEqual([]);
  }, TEST_MS);

  it('stops rather than loops if the real hooks path is the shim itself', () => {
    git(main, 'config', 'core.hooksPath', heavyHooksDir());
    const run = push(pushEnv(AGENT));
    expect(run.status, run.stderr).toBe(0);
    expect(history()).toEqual([]);
  }, TEST_MS);

  it('husky re-running its config in the worktree does not clobber the shim', () => {
    git(wt, 'config', 'core.hooksPath', '.husky/_');
    expect(git(wt, 'config', '--worktree', 'core.hooksPath')).toBe(heavyHooksDir());
    expect(git(wt, 'config', 'core.hooksPath')).toBe(heavyHooksDir());
    expect(git(main, 'config', 'core.hooksPath')).toBe('.husky/_');
  }, TEST_MS);
});

describe('light pushes', () => {
  const zero = '0'.repeat(40);
  const noRules = undefined;

  it('deleting a branch checks nothing; anything unknown is heavy', () => {
    expect(isLightPush(`(delete) ${zero} refs/heads/x abc`, 'origin', root, noRules)).toBe(true);
    expect(isLightPush('', 'origin', root, noRules)).toBe(false);
    expect(isLightPush('not a ref line', 'origin', root, { lightRefs: [], lightPaths: ['a/'] })).toBe(false);
    expect(isLightPush(`refs/heads/x abc refs/heads/x ${zero}`, 'origin', root, noRules)).toBe(false);
  });

  it('every ref in the push must be light', () => {
    const rules = { lightRefs: ['refs/heads/pr-evidence'], lightPaths: [] };
    expect(isLightPush(`a abc refs/heads/pr-evidence ${zero}`, 'origin', root, rules)).toBe(true);
    expect(isLightPush(`a abc refs/heads/pr-evidence ${zero}\nb abc refs/heads/other ${zero}`, 'origin', root, rules)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('applying the shim', () => {
  it('leaves the main checkout on its own hooks', () => {
    expect(applyHeavyHooks(main)).toBe(false);
    expect(spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: main }).status).toBe(1);
  });

  it('turns on per-worktree config for a repo without it, and is idempotent', () => {
    expect(spawnSync('git', ['config', '--local', 'extensions.worktreeConfig'], { cwd: main }).status).toBe(1);
    expect(applyHeavyHooks(wt)).toBe(true);
    expect(applyHeavyHooks(wt)).toBe(true);
    expect(git(main, 'config', '--local', 'extensions.worktreeConfig')).toBe('true');
    expect(git(wt, 'config', '--worktree', 'core.hooksPath')).toBe(heavyHooksDir());
  });

  it('keeps a hooks path someone set for this worktree', () => {
    git(main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'core.hooksPath', '/somewhere/else');
    expect(applyHeavyHooks(wt)).toBe(false);
    expect(git(wt, 'config', '--worktree', 'core.hooksPath')).toBe('/somewhere/else');
  });

  it('does not throw outside a repo', () => {
    expect(applyHeavyHooks(path.join(root, 'nowhere'))).toBe(false);
  });
});
