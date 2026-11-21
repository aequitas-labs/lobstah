import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, signOnTrap, toolProjectEnv } from '@lobstah/core';
import { runBeat } from '../src/beat.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// The post-tool hook records the project a trap's own ume calls set inline,
// so the daemon's wait for that session reads the same project.
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-beat-project-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const noGit = () => ({ status: 1, stdout: '' });

it.each([
  { harness: 'claude' as const, tool: 'Bash', input: { command: 'UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434' } },
  { harness: 'codex' as const, tool: 'functions.exec_command', input: { cmd: 'UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434' } },
  { harness: 'codex' as const, tool: 'shell', input: { command: ['bash', '-lc', 'UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434'] } },
])("records $harness/$tool's inline UME_PROJECT only for its trap session", ({ harness, tool, input }) => {
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const signed = signOnTrap({ sessionId: 'trap-s', harness, repo: 'web', worktree: wt, cwd: wt, ttlMs: 60_000 });
  expect('ok' in signed).toBe(true);
  runBeat({ session_id: 'trap-s', cwd: wt, tool_name: tool, tool_input: input }, { run: noGit });
  runBeat({ session_id: 'other-s', cwd: home, tool_name: tool, tool_input: input }, { run: noGit });
  expect(toolProjectEnv('trap-s', 'ume')).toEqual({ UME_PROJECT: 'vr95mce908' });
  expect(toolProjectEnv('other-s', 'ume')).toEqual({});
});

it('records the project when activity beats are disabled', () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nbeat = false\n');
  signOnTrap({ sessionId: 'trap-s', harness: 'codex', repo: 'web', worktree: home, cwd: home, ttlMs: 60_000 });
  runBeat({ session_id: 'trap-s', cwd: home, tool_input: { cmd: 'UME_PROJECT=p ume-next feedback a1' } }, { run: noGit });
  expect(toolProjectEnv('trap-s', 'ume')).toEqual({ UME_PROJECT: 'p' });
});
