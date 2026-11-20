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

it("records a trap's inline UME_PROJECT, and nothing for a session that isn't a trap", () => {
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const signed = signOnTrap({ sessionId: 'trap-s', harness: 'claude', repo: 'web', worktree: wt, cwd: wt, ttlMs: 60_000 });
  expect('ok' in signed).toBe(true);
  const command = 'UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434';
  runBeat({ session_id: 'trap-s', cwd: wt, tool_name: 'Bash', tool_input: { command } }, { run: noGit });
  runBeat({ session_id: 'other-s', cwd: home, tool_name: 'Bash', tool_input: { command } }, { run: noGit });
  expect(toolProjectEnv('trap-s', 'ume')).toEqual({ UME_PROJECT: 'vr95mce908' });
  expect(toolProjectEnv('other-s', 'ume')).toEqual({});
});
