import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoConfig } from '@lobstah/core';
import { runSetup, SetupCommandError } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-setup-'));
});
afterEach(() => removeTempDir(dir));

/** A repo whose one setup command runs `script` with node in the checkout. */
function repoRunning(script: string, env?: Record<string, string>): RepoConfig {
  fs.writeFileSync(path.join(dir, 'setup.cjs'), script);
  return { path: dir, trunk: 'main', setup: ['node setup.cjs'], ...(env ? { env } : {}) } as RepoConfig;
}

describe('repo setup runs unattended', () => {
  it('turns off pnpm’s modules-purge prompt and gives the command a closed stdin', async () => {
    // Reading stdin ends at once: a prompt sees end of input, not a wait for a person.
    const repo = repoRunning(`
      process.stdin.resume();
      process.stdin.on('end', () => require('fs').writeFileSync('seen.json', JSON.stringify({ purge: process.env.npm_config_confirm_modules_purge })));
    `);
    await runSetup(repo, dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'))).toEqual({ purge: 'false' });
  });

  it('keeps a value the repo sets for itself', async () => {
    const repo = repoRunning(`require('fs').writeFileSync('seen.json', JSON.stringify({ purge: process.env.npm_config_confirm_modules_purge }));`, {
      npm_config_confirm_modules_purge: 'true',
    });
    await runSetup(repo, dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'))).toEqual({ purge: 'true' });
  });

  it('a failed command reports its exit code and the end of what it printed', async () => {
    // pnpm prints its errors on stdout; a warning on stderr must not hide them.
    const repo = repoRunning(`
      console.log('Lockfile is up to date');
      console.log('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY  Aborted removal of modules directory due to no TTY');
      console.error('WARN  a deprecation notice');
      process.exit(1);
    `);
    const failure = await runSetup(repo, dir).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SetupCommandError);
    expect((failure as SetupCommandError).exitCode).toBe(1);
    expect((failure as Error).message).toContain('setup command `node setup.cjs` failed (exit 1)');
    expect((failure as Error).message).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY');
    expect((failure as Error).message).toContain('WARN  a deprecation notice');
    expect((failure as Error).message).not.toContain('\n');
  });
});
