import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, enqueue, ensureLayout, signOnTrap } from '@lobstah/core';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-title-cli-'));
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function signOn() {
  const result = signOnTrap({ sessionId: 'own-session', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 1_800_000, name: 'amber-gull' });
  if ('held' in result) throw new Error('unexpected hold');
  return result.ok;
}

function run(args: string[], cwd = worktree, stdin?: string) {
  const env = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, input: stdin, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('soak title and SessionStart output', () => {
  it('prints nothing without a trap or with the switch off', () => {
    expect(run(['soak', 'title', '--json'])).toBe('');
    signOn();
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nsessionTitle = false\n');
    expect(run(['soak', 'title', '--session', 'own-session'])).toBe('');
  });

  it('prints plain and JSON titles for its own session', () => {
    const reg = signOn();
    expect(run(['soak', 'title', '--session', 'own-session'])).toBe('amber-gull');
    expect(JSON.parse(run(['soak', 'title', '--json', '--session', 'own-session']))).toEqual({ title: 'amber-gull', name: 'amber-gull', work: null });
    enqueue({ id: 'title-work', repo: 'web', brief: '# Ship a short feature\nIgnore this line' });
    claimBait(reg);
    expect(JSON.parse(run(['soak', 'title', '--json', '--session', 'own-session']))).toEqual({
      title: 'amber-gull · Ship a short feature', name: 'amber-gull', work: 'Ship a short feature',
    });
    expect(run(['soak', 'title', '--session', 'other-session'])).toBe('');
  });

  it('leaves the existing SessionStart brief unchanged for traps and other sessions', () => {
    signOn();
    const input = JSON.stringify({ session_id: 'own-session', cwd: worktree, hook_event_name: 'SessionStart' });
    const ordinary = JSON.parse(run(['man', 'brief'], worktree, input));
    expect(ordinary.hookSpecificOutput.sessionTitle).toBeUndefined();
    expect(ordinary.hookSpecificOutput.additionalContext).toContain('own-session');

    const foreign = JSON.parse(run(['man', 'brief'], home, JSON.stringify({ session_id: 'foreign', cwd: home })));
    expect(foreign.hookSpecificOutput.sessionTitle).toBeUndefined();
    expect(foreign.hookSpecificOutput.additionalContext).toContain('foreign');
  });
});
