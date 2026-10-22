import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, laneDirs } from '@lobstah/core';
import { briefPrMentions, resolvePrTarget } from '../src/pr-target.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let bin: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-target-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.web]\npath = "/w"\norigin = "git@github.com:acme/web.git"\n');
  // A fake gh: `pr view` answers an open PR on branch fix-loop.
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const answer = JSON.stringify({ state: 'OPEN', headRefName: 'fix-loop' });
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\necho ${answer}\r\n`);
  else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${answer}'\n`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
  }
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const lobstah = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    // A bare Windows spawn finds gh.exe, not the gh.cmd fixture. Keep the
    // machine's PATH out so it cannot fall through to a real, networked gh.
    env: { ...process.env, LOBSTAH_HOME: home, PATH: bin, CLAUDE_CODE_SESSION_ID: '' },
    timeout: 20_000,
  });
const queued = () =>
  fs.readdirSync(laneDirs('work').queue).map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as { brief: string; pr?: { url: string; headRefName?: string } });

describe('resolvePrTarget', () => {
  const open = () => ({ state: 'OPEN', headRefName: 'fix-loop' });
  it('takes a number, #n, a URL, or owner/repo#n in the repo, and records the head branch', () => {
    for (const v of ['241', '#241', 'https://github.com/acme/web/pull/241', 'https://github.com/Acme/web/pull/241/files', 'acme/web#241']) {
      expect(resolvePrTarget('web', v, open)).toMatchObject({ headRefName: 'fix-loop' });
      expect(resolvePrTarget('web', v, open).url.toLowerCase()).toBe('https://github.com/acme/web/pull/241');
    }
    expect(resolvePrTarget('web', '241', () => undefined)).toEqual({ url: 'https://github.com/acme/web/pull/241' }); // gh unavailable: the URL alone
  });

  it('refuses a PR in another repo, a closed or merged one, and anything that is not a PR', () => {
    expect(() => resolvePrTarget('web', 'https://github.com/acme/api/pull/3', open)).toThrow('is not in repo web (acme/web)');
    expect(() => resolvePrTarget('web', '241', () => ({ state: 'MERGED' }))).toThrow('is merged; a dispatch can only push to an open PR');
    expect(() => resolvePrTarget('web', 'the fix branch', open)).toThrow('--pr takes a PR URL');
  });

  it('finds the repo PRs a brief names', () => {
    expect(briefPrMentions('Push to https://github.com/acme/web/pull/241 (see also https://github.com/acme/api/pull/9).', 'web')).toEqual(['https://github.com/acme/web/pull/241']);
  });
});

describe('dispatch --pr', () => {
  it('writes the PR into the descriptor, so the runner keeps it and opens none', () => {
    const r = lobstah('dispatch', '--repo', 'web', '--brief-text', '# Fix the repair loop\n\nPush the fix to #241.', '--pr', '241');
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('pr: https://github.com/acme/web/pull/241');
    // Windows cannot execute the .cmd fixture without a shell: gh is
    // unavailable there, so the descriptor records the URL alone.
    const pr = process.platform === 'win32' ? { url: 'https://github.com/acme/web/pull/241' } : { url: 'https://github.com/acme/web/pull/241', headRefName: 'fix-loop' };
    expect(queued()).toEqual([expect.objectContaining({ pr })]);
  });

  it('warns when the brief names a PR of the repo but --pr is not given', () => {
    const r = lobstah('dispatch', '--repo', 'web', '--brief-text', 'Push the fix to https://github.com/acme/web/pull/241.');
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('dispatch with --pr https://github.com/acme/web/pull/241');
    expect(queued()[0]!.pr).toBeUndefined();
  });

  it('send refuses --pr when it only delivers a message', () => {
    const r = lobstah('send', 'amber-gull', '--pr', '241', 'hello');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('--pr applies only when send starts a follow-up');
  });
});
