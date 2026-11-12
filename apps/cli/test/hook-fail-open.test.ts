import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout } from '@lobstah/core';
import { claudeHooks, hookRow } from '../src/hook-readiness.js';
import { knownHookCommand, readHookFailures, recordHookFailure } from '../src/hook-failures.js';
import { recordHookRun } from '../src/hook-runs.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A lobstah hook fails open: `lobstah hook …` never exits 2 (a harness reads
 * that as "block"), records what went wrong, and `lobstah doctor` names a
 * hook command the CLI doesn't know or a hook that failed since its last run.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const NOW = Date.parse('2026-11-12T12:00:00Z');
let dir: string;
let home: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hook-fail-open-'));
  home = path.join(dir, 'user');
  fs.mkdirSync(home);
  process.env.LOBSTAH_HOME = path.join(dir, 'lobstah');
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

const hook = (...args: string[]) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: '7b1d4c52-0d1e-4f3a-9a77-3c2f1e0b9d10', cwd: dir });
  return spawnSync(process.execPath, [cli, 'hook', ...args], { input, env: { ...env, LOBSTAH_HOME: process.env.LOBSTAH_HOME }, encoding: 'utf8', timeout: 20_000 });
};

describe('lobstah hook fails open', () => {
  it('a flag this CLI does not know exits 0, says so on stderr, and is recorded under its event', () => {
    const res = hook('stop', '--yield-to-owner');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('lobstah hook stop:');
    expect(res.stderr).toContain('--yield-to-owner');
    expect(readHookFailures().Stop).toMatchObject({ command: 'hook stop --yield-to-owner' });
  });

  it('an event this CLI does not know exits 0 too', () => {
    const res = hook('stop-failure');
    expect(res.status).toBe(0);
    expect(readHookFailures().hook).toMatchObject({ command: 'hook stop-failure' });
  });
});

describe('which hook commands this CLI runs', () => {
  it.each([
    ['Stop', 'lobstah hook stop', true],
    ['Stop', 'lobstah man haul', true],
    ['SessionEnd', 'lobstah stow --quiet', true],
    ['PreToolUse', 'lobstah hook pre-tool-use codex', true],
    ['Stop', 'lobstah hook stop --yield-to-owner', false],
    ['Stop', 'lobstah hook session-start', false],
    ['Stop', 'lobstah hook', false],
    ['Stop', 'ume hook stop', true],
  ])('%s: %s → %s', (event, command, known) => {
    expect(knownHookCommand(event, command)).toBe(known);
  });
});

describe('doctor: a hook that does nothing', () => {
  function claudeHome(stop: string): void {
    const root = path.join(home, 'plugin');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lobstah', version: '0.9.0' }));
    const cmd = (c: string) => [{ hooks: [{ type: 'command', command: c }] }];
    fs.writeFileSync(
      path.join(root, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: cmd('lobstah hook session-start'), PostToolUse: cmd('lobstah hook post-tool-use'), Stop: cmd(stop), SessionEnd: cmd('lobstah hook session-end') } }),
    );
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'lobstah@lobstah': [{ installPath: root, version: '0.9.0' }] } }));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  }
  const opts = () => ({ home, env: {} as NodeJS.ProcessEnv, now: NOW });

  it('a plugin hook command the CLI does not know fails the row, and the trap is not ready', () => {
    claudeHome('lobstah hook stop --yield-to-owner');
    const row = hookRow(claudeHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain("Stop: installed, trust n/a, never run, runs `lobstah hook stop --yield-to-owner`, which this CLI doesn't know");
    expect(row.detail).toContain('trap not ready (needs Stop)');
    expect(row.detail).toContain('the plugin and the CLI disagree on Stop');
  });

  it('a failure since the last run fails the row; a good run after it clears it', () => {
    claudeHome('lobstah hook stop');
    recordHookRun('Stop', 'claude', NOW - 80_000);
    recordHookFailure(['stop'], 'boom', NOW - 60_000);
    const row = hookRow(claudeHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('Stop: installed, trust n/a, last run 80s ago, failed 60s ago (`lobstah hook stop`: boom)');
    expect(row.detail).toContain('trap not ready (needs Stop)');
    expect(row.detail).toContain('Stop failed open since its last good run');
    recordHookRun('Stop', 'claude', NOW - 10_000);
    expect(hookRow(claudeHooks(opts()), NOW).status).toBe('ok');
  });
});
