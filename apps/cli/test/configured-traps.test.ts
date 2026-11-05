import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, ensureLayout, listTraps, loadConfig, pendingIds, readStatusLog, resolveGrounds, storedDescriptor, takeHelm } from '@lobstah/core';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.LOBSTAH_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-configured-cli-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[traps.ops]\nharness="claude"\nsurface="terminal"\ngrounds="fleet"\n');
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.LOBSTAH_HOME; else process.env.LOBSTAH_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
function run(...arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, ...arguments_], { cwd: home, encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home, CLAUDE_CODE_ENTRYPOINT: 'cli' }, timeout: 15_000 });
}

it('runs a repo-less catch through the built CLI and rejects repo evidence before filing', () => {
  takeHelm({ sessionId: 'helm-session', grounds: resolveGrounds(loadConfig(), 'fleet'), ttlMs: 60_000 });
  const signed = run('soak', '--trap', 'ops', '--session', 'worker-session', '--harness', 'claude');
  expect(signed.stderr).toBe('');
  expect(signed.status).toBe(0);
  expect(String(signed.stdout)).toContain('repo: none');
  const refused = run('dispatch', '--for', 'trap:ops', '--session', 'other-session', '--brief-text', 'Inspect scratch');
  expect(refused.status).not.toBe(0);
  expect(pendingIds('work')).toEqual([]);
  const queued = run('dispatch', '--for', 'trap:ops', '--session', 'helm-session', '--id', 'configured-task', '--brief-text', 'Inspect scratch');
  expect(queued.stderr).toBe('');
  expect(queued.status).toBe(0);
  expect(storedDescriptor('configured-task', 'work')?.repo).toBeUndefined();
  expect(claimBait(listTraps()[0]!)?.id).toBe('configured-task');
  const report = path.join(home, 'findings.md'); fs.writeFileSync(report, '# Findings\nLooks correct\n');
  const invalid = run('report', 'configured-task', 'done', 'Complete', '--pr', 'https://github.com/a/b/pull/1', '--report', report, '--session', 'worker-session');
  expect(invalid.status).not.toBe(0);
  expect(readStatusLog('configured-task', 'work').at(-1)?.verb).toBe('working');
  const complete = run('report', 'configured-task', 'done', 'Complete', '--report', report, '--session', 'worker-session');
  expect(complete.stderr).toBe('');
  expect(complete.status).toBe(0);
  const stowed = run('stow', '--session', 'worker-session');
  expect(stowed.status).toBe(0);
  expect(fs.existsSync(path.join(home, 'trap-workspaces'))).toBe(true);
}, 30_000);

it('keeps configured folders out of pressure culls even after forgetting their slot', async () => {
  const { withConfiguredTrapSlot, forgetConfiguredTrapSlot } = await import('@lobstah/core');
  const { planPressureCull, removeWorktree } = await import('../src/cull.js');
  const cwd = path.join(home, 'worktrees', 'user-folder'); fs.mkdirSync(cwd, { recursive: true });
  const slot = withConfiguredTrapSlot('ops', { harness: 'claude', surface: 'terminal', grounds: 'fleet', maxInstances: 1, cwd }, undefined, (instance) => instance);
  forgetConfiguredTrapSlot(slot.trapId);
  expect(planPressureCull().some((candidate) => candidate.target === cwd)).toBe(false);
  expect(() => removeWorktree('user-folder', cwd)).toThrow(/never culled/);
  expect(fs.existsSync(cwd)).toBe(true);
});
