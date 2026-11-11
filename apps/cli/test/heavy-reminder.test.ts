import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimBait, enqueue, ensureLayout, signOnTrap, stowTrap } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
let wt: string;
const prior = process.env.LOBSTAH_HOME;

function hook(input: Record<string, unknown>) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, 'hook', 'pre-tool-use'], { input: JSON.stringify(input), env, cwd: wt, encoding: 'utf8' });
}
const bash = (command: string, session = 's1') => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: wt });

function trapOnDispatch() {
  const res = signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: 'claude', sessionId: 's1', ttlMs: 60_000 });
  if (!('ok' in res)) throw new Error('sign-on refused');
  enqueue({ id: 'd1', repo: 'r', brief: 'x', for: `wt:${res.ok.trapId}` });
  expect(claimBait(res.ok)?.id).toBe('d1');
  return res.ok;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-hook-')));
  wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  if (prior === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = prior;
  removeTempDir(home);
});

describe('the heavy reminder in the pre-tool hook', () => {
  it('adds one line of context with no permission decision, once per dispatch for each pattern', () => {
    trapOnDispatch();
    const first = hook(bash('npx vitest run'));
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(out.hookSpecificOutput.additionalContext).toContain('Next time use: lobstah heavy -- npx vitest run');
    expect(hook(bash('env -u X npx vitest run')).stdout).toBe('');
    expect(JSON.parse(hook(bash('pnpm test')).stdout).hookSpecificOutput.additionalContext).toContain('lobstah heavy -- pnpm test');
  });

  it('says nothing for focused or queued commands, other tools, or a session on no dispatch', () => {
    trapOnDispatch();
    expect(hook(bash('npx vitest run a.test.ts')).stdout).toBe('');
    expect(hook(bash('lobstah heavy -- npx vitest run')).stdout).toBe('');
    expect(hook({ session_id: 's1', tool_name: 'Read', tool_input: { command: 'npx vitest run' }, cwd: wt }).stdout).toBe('');
    expect(hook(bash('npx vitest run', 'a-person')).stdout).toBe('');
  });

  it('says nothing once the trap has stowed', () => {
    const reg = trapOnDispatch();
    stowTrap(reg.trapId);
    expect(hook(bash('npx vitest run')).stdout).toBe('');
  });

  it('uses a repo\'s own names', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[heavy.repos.r]\nreminders = ["make check"]\n');
    trapOnDispatch();
    expect(JSON.parse(hook(bash('make check')).stdout).hookSpecificOutput.additionalContext).toContain('lobstah heavy -- make check');
  });
});
