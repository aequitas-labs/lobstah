import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { enqueue, ensureLayout, readTrap, signOnTrap, stowTrap } from '@lobstah/core';
import { stopChildren } from '../../../test/child-process.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-quiet-park-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\npark="block"\n');
});
afterEach(async () => {
  await stopChildren(children.splice(0));
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.each(['claude', 'codex'])('%s Stop renews quiet deadlines without a model continuation, then bait wakes it', async harness => {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness, sessionId: 'idle-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  const child = spawn(process.execPath, [cli, 'hook', 'stop', '--timeout', '0.05'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stdin!.end(JSON.stringify({ session_id: 'idle-session', hook_event_name: 'Stop' }));
  for (let i = 0; i < 100 && !readTrap(signed.ok.trapId)?.idleSince; i++) await sleep(20);
  const before = readTrap(signed.ok.trapId)!;
  expect(before.idleSince).toBeDefined();
  await sleep(180); // Several complete quiet deadlines.
  expect(child.exitCode).toBeNull();
  expect(output).toBe(''); // No block JSON to request a model turn.
  expect(Date.parse(readTrap(signed.ok.trapId)!.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
  enqueue({ id: 'real-bait', repo: 'r', brief: 'Wake for this work', for: `wt:${signed.ok.trapId}` });
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  expect(JSON.parse(output)).toMatchObject({ decision: 'block' });
  expect(output).toContain('Wake for this work');
}, 10_000);

it('a plain listener stays in its process across quiet deadlines and exits on sign-off', async () => {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness: 'claude', sessionId: 'idle-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  const child = spawn(process.execPath, [cli, 'soak', '--wait', '--timeout', '0.05', '--session', 'idle-session'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); });
  for (let i = 0; i < 100 && !readTrap(signed.ok.trapId)?.idleSince; i++) await sleep(20);
  await sleep(180);
  expect(child.exitCode).toBeNull();
  expect(output).not.toContain('timeout: true');
  stowTrap(signed.ok.trapId, 'test sign-off');
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  expect(output).not.toContain('timeout: true');
}, 10_000);
