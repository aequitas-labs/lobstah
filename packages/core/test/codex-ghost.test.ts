import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, heartbeatTrap, sessionHolderText, signOnTrap, sweepGhostTraps } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-ghost-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const PROC = { pid: 4242, startedAt: 'Wed Nov 11 12:22:35 2026' };

function parkedCodexTrap(name: string, over: { codexServer?: true } = {}): string {
  const worktree = path.join(home, name);
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'codex', sessionId: `${name}-thread`, ttlMs: 60_000, ...(over.codexServer ? { codexServer: true } : { harnessProcess: PROC }) });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  heartbeatTrap(signed.ok.trapId, { parked: true });
  return signed.ok.trapId;
}

it("hands the daemon a ghosted Codex trap's own process and thread, to stop once it checks the thread lock", () => {
  const own = parkedCodexTrap('own-tui');
  const server = parkedCodexTrap('on-server', { codexServer: true });
  const actions = sweepGhostTraps(1000, Date.now() + 3_600_000);
  expect(actions.find((a) => a.trapId === own)?.codexProcess).toEqual({ ...PROC, threadId: 'own-tui-thread' });
  // A trap on the shared server has no process of its own: the server hosts every trap.
  expect(actions.find((a) => a.trapId === server)?.codexProcess).toBeUndefined();
});

it("says plainly which Codex process holds a thread, instead of Codex's \"open in another app\"", () => {
  const text = sessionHolderText('01a1cc09-0f4e-73c0-8b48-7b1d57b46631', [{ pid: 3903, pane: '%3', codexWriter: true }]);
  expect(text).toContain('Codex process 3903 (tmux pane %3) holds the thread');
  expect(text).toContain('--stop-stale');
});
