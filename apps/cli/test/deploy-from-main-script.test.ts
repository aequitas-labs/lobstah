import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The glass runs a run card's script from a copy in its own run directory, so
 * deploy-from-main.sh can't find the checkout from its own location. It tries
 * LOBSTAH_REPO, then the working directory, then its own location. --dry-run
 * stops once the checkout is found, before any fetch or deploy.
 */

const script = fs.readFileSync(new URL('../../../services/wharf/scripts/deploy-from-main.sh', import.meta.url), 'utf8');
const slash = (s: string) => s.replace(/\\/g, '/');
const bash = process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';
let root: string, checkout: string, other: string, runDir: string;
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const run = (cwd: string, extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: slash(root), ...extra };
  if (!('LOBSTAH_REPO' in extra)) delete env.LOBSTAH_REPO;
  return spawnSync(bash, [slash(path.join(runDir, 'deploy-from-main.sh')), '--dry-run'], { cwd, env, encoding: 'utf8' });
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-deploy-script-test-')));
  // A stand-in checkout with no origin: a fetch or deploy from it would fail.
  checkout = path.join(root, 'lobstah'); other = path.join(root, 'other'); runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(checkout, 'services/wharf'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'services/wharf/wrangler.jsonc'), '{}\n');
  git(['init', '-q'], checkout);
  fs.mkdirSync(other); git(['init', '-q'], other);
  fs.mkdirSync(runDir); fs.writeFileSync(path.join(runDir, 'deploy-from-main.sh'), script);
});
afterEach(() => removeTempDir(root));

const found = (result: ReturnType<typeof run>) => {
  expect(result.status, result.stdout + result.stderr).toBe(0);
  // Git's own spelling of the checkout: on Windows the temp dir can be an 8.3 short path git expands.
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, encoding: 'utf8' }).trim();
  expect(result.stdout.trim()).toBe(`Would deploy main from ${top}. Dry run: nothing changed.`);
};

it('finds the checkout from LOBSTAH_REPO when run from a copy', () => {
  found(run(runDir, { LOBSTAH_REPO: slash(checkout) }));
});

it('finds the checkout from the working directory when run from a copy', () => {
  found(run(path.join(checkout, 'services/wharf')));
});

it('passes over a LOBSTAH_REPO that is not the lobstah checkout', () => {
  found(run(checkout, { LOBSTAH_REPO: slash(other) }));
});

it('stops with one line naming LOBSTAH_REPO when nothing finds the checkout', () => {
  const result = run(other);
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe("Couldn't find the lobstah checkout. Set LOBSTAH_REPO to it, or run this from inside it. Nothing changed.");
});

it('still finds the checkout from its own location', () => {
  runDir = path.join(checkout, 'services/wharf/scripts');
  fs.mkdirSync(runDir); fs.writeFileSync(path.join(runDir, 'deploy-from-main.sh'), script);
  found(run(other));
});
