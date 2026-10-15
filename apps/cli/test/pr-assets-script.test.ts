import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTempDir } from '../../../test/temp-dir.js';

const script = fs.readFileSync(new URL('../../../scripts/pr-assets.sh', import.meta.url), 'utf8');
const slash = (s: string) => s.replace(/\\/g, '/');
const bash = process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';
let root: string, source: string, bare: string, seed: string, env: NodeJS.ProcessEnv;
const git = (args: string[], cwd = source) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (...args: string[]) => spawnSync(bash, [slash(path.join(source, 'scripts/pr-assets.sh')), ...args.map(slash)], { cwd: source, env, encoding: 'utf8' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-assets-test-'));
  source = path.join(root, 'source'); bare = path.join(root, 'remote.git'); seed = path.join(root, 'seed');
  env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Evidence test', GIT_AUTHOR_EMAIL: 'evidence@example.test', GIT_COMMITTER_NAME: 'Evidence test', GIT_COMMITTER_EMAIL: 'evidence@example.test' };
  fs.mkdirSync(source); fs.mkdirSync(seed);
  git(['init', '--bare', bare]);
  // Redirect only this test's GitHub origin to a local bare remote. No network or real config.
  git(['config', '--global', `url.${slash(bare)}.insteadOf`, 'https://github.com/aequitas-labs/lobstah.git']);
  git(['init', '-b', 'pr-evidence'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'Shared evidence\n');
  git(['add', 'README.md'], seed); git(['commit', '-m', 'Evidence root'], seed);
  git(['remote', 'add', 'origin', bare], seed); git(['push', 'origin', 'pr-evidence'], seed);
  git(['init', '-b', 'main']); git(['remote', 'add', 'origin', 'https://github.com/aequitas-labs/lobstah.git']);
  fs.mkdirSync(path.join(source, 'scripts')); fs.writeFileSync(path.join(source, 'scripts/pr-assets.sh'), script);
  fs.writeFileSync(path.join(source, 'source.txt'), 'Source\n'); git(['add', '.']); git(['commit', '-m', 'Source']);
});
afterEach(() => removeTempDir(root));

it('uploads evidence, pins image/file links, preserves the caller and is idempotent', () => {
  fs.writeFileSync(path.join(source, 'source.txt'), 'Unsaved work\n');
  fs.writeFileSync(path.join(source, 'before.png'), 'dummy PNG fixture');
  fs.writeFileSync(path.join(source, 'checks.txt'), 'Checks pass\n');
  const status = git(['status', '--porcelain']), head = git(['rev-parse', 'HEAD']);
  const first = run('42', 'before.png', 'checks.txt'); expect(first.status, first.stderr).toBe(0);
  const assetHead = git(['rev-parse', 'pr-evidence'], bare);
  expect(first.stdout).toBe(`![before.png](https://raw.githubusercontent.com/aequitas-labs/lobstah/${assetHead}/pr-42/before.png)\n[checks.txt](https://raw.githubusercontent.com/aequitas-labs/lobstah/${assetHead}/pr-42/checks.txt)\n`);
  expect(git(['show', 'pr-evidence:pr-42/checks.txt'], bare)).toBe('Checks pass');
  expect(git(['status', '--porcelain'])).toBe(status); expect(git(['rev-parse', 'HEAD'])).toBe(head);
  const again = run('42', 'before.png', 'checks.txt'); expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toBe(first.stdout); expect(git(['rev-parse', 'pr-evidence'], bare)).toBe(assetHead);
});

it('rebases and retries a deterministic push race, preserving both uploads and pinning the new commit', () => {
  fs.writeFileSync(path.join(seed, 'other.txt'), 'Concurrent evidence\n'); git(['add', 'other.txt'], seed); git(['commit', '-m', 'Concurrent upload'], seed);
  // Git for Windows supplies its own command search path. A template hook in
  // the helper's new clone injects the race portably, without PATH interception.
  const templates = path.join(root, 'templates'); fs.mkdirSync(path.join(templates, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'hooks/pre-push'), '#!/usr/bin/env bash\nset -e\nif [[ ! -e $RACE_MARKER ]]; then\n  : > "$RACE_MARKER"\n  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY\n  git -C "$RACE_PEER" push origin pr-evidence >&2\nfi\n', { mode: 0o755 });
  env = { ...env, GIT_TEMPLATE_DIR: slash(templates), RACE_PEER: slash(seed), RACE_MARKER: slash(path.join(root, 'raced')) };
  fs.writeFileSync(path.join(source, 'after.png'), 'dummy image');
  const result = run('43', 'after.png'); expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(path.join(root, 'raced'))).toBe(true);
  expect(git(['show', 'pr-evidence:other.txt'], bare)).toBe('Concurrent evidence');
  expect(git(['show', 'pr-evidence:pr-43/after.png'], bare)).toBe('dummy image');
  expect(result.stdout).toContain(`/lobstah/${git(['rev-parse', 'pr-evidence'], bare)}/pr-43/after.png)`);
  expect(git(['rev-list', '--count', 'pr-evidence'], bare)).toBe('3');
});

it('rejects bad PR numbers, missing files and colliding basenames before any upload', () => {
  const head = git(['rev-parse', 'pr-evidence'], bare);
  expect(run('../main', 'missing').status).not.toBe(0);
  expect(run('1', 'missing').stderr).toContain('Not a regular file');
  fs.mkdirSync(path.join(source, 'a')); fs.mkdirSync(path.join(source, 'b'));
  fs.writeFileSync(path.join(source, 'a/same.png'), 'one'); fs.writeFileSync(path.join(source, 'b/same.png'), 'two');
  expect(run('1', 'a/same.png', 'b/same.png').stderr).toContain('Duplicate filename');
  expect(git(['rev-parse', 'pr-evidence'], bare)).toBe(head);
});
