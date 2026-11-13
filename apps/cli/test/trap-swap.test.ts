import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  baitBrief,
  claimBait,
  enqueue,
  ensureLayout,
  loadConfig,
  queuedDescriptor,
  readRoster,
  readSessionClaim,
  sendMessage,
  signOnTrap,
  releaseCatch,
  stowTrap,
  unhandled,
} from '@lobstah/core';
import { swapTrapCatch } from '../src/trap-swap.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const beforeHome = process.env.LOBSTAH_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-swap-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${home.replaceAll('\\', '/')}'\n`);
});
afterEach(() => {
  if (beforeHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = beforeHome;
  removeTempDir(home);
});

it.each([false, true])('preserves the branch, brief, git note and inbox when swapping (already requeued: %s)', async (requeued) => {
  const worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  execFileSync('git', ['init', '-b', 'task-progress', worktree], { stdio: 'ignore' });
  fs.writeFileSync(path.join(worktree, 'progress.txt'), 'unfinished change');
  const signed = signOnTrap({
    worktree,
    cwd: worktree,
    repo: 'r',
    harness: 'claude',
    sessionId: 'old',
    ttlMs: 60_000,
    harnessProcess: { pid: 999999, startedAt: 'test process' },
  });
  if (!('ok' in signed)) throw new Error('could not sign on');
  enqueue({ id: 'swap-work', repo: 'r', brief: 'Finish this change', for: `wt:${signed.ok.trapId}` });
  claimBait(signed.ok);
  sendMessage('swap-work', 'work', 'Keep the pending fix', 'helm');
  if (requeued) {
    stowTrap(signed.ok.trapId);
    releaseCatch(signed.ok);
  }
  const order: string[] = [];
  const result = await swapTrapCatch('swap-work', 'work', {
    cfg: loadConfig(),
    harness: 'codex',
    endProcess: async (process) => {
      expect(process.pid).toBe(999999);
      order.push('stop');
      return 'ended';
    },
    launch: async (options) => {
      order.push('launch');
      const descriptor = queuedDescriptor('swap-work', 'work')!;
      expect(descriptor.harness).toBe('codex');
      expect(descriptor.brief).toBe('Finish this change');
      expect(descriptor.handoff).toContain('progress.txt');
      expect(baitBrief('swap-work', descriptor)).toContain('existing task branch');
      expect(unhandled('swap-work', 'work')[0]?.text).toBe('Keep the pending fix');
      const next = signOnTrap({
        worktree,
        cwd: worktree,
        repo: 'r',
        harness: 'codex',
        sessionId: 'new',
        trapId: signed.ok.trapId,
        ttlMs: 60_000,
      });
      if (!('ok' in next)) throw new Error('could not sign on replacement');
      expect(claimBait(next.ok)?.id).toBe('swap-work');
      return {
        trap: options.address,
        action: 'cold',
        why: 'swap',
        checkout: 'kept',
        terminal: 'terminal',
        harness: 'codex',
        command: 'codex',
        unapplied: [],
        mode: 'auto',
        registration: next.ok,
      };
    },
  });
  expect(order).toEqual(['stop', 'launch']);
  expect(result.registration.worktree).toBe(worktree);
  expect(readRoster(signed.ok.trapId)?.profile?.harness).toBe('codex');
  expect(readSessionClaim('swap-work', 'work')?.harness).toBe('codex');
  expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe('task-progress');
});
