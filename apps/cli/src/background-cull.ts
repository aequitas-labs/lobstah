import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { COMPILED_BINARY, GB, laneDirs, loadConfig, lobstahHome, statfsFreeBytes, storedDescriptor, tryDirLock, worktreesDir, recoverTrapCaches } from '@lobstah/core';
import type { FreeBytesReader } from '@lobstah/core';
import { releaseReviewWorktree } from '@lobstah/worktree';
import { retentionPass } from '@lobstah/supervisor';
import { cliCuller } from './auto-cull.js';

let running: ChildProcess | undefined;
let reviewPending = false;

/** One detached worker drains the backlog; the daemon stays free to claim work. */
export function startBackgroundCull(log: (m: string) => void, reviewFinished = false): boolean {
  if (running) {
    reviewPending ||= reviewFinished;
    return false;
  }
  let fd: number | undefined;
  try {
    const dir = path.join(lobstahHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, 'cull.log'), 'a');
    const args = COMPILED_BINARY ? ['__cull'] : [process.argv[1]!, '__cull'];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    running = child;
    child.once('error', (error) => { running = undefined; log(`cull worker: ${error.message}`); });
    child.once('exit', () => {
      running = undefined;
      if (reviewPending) { reviewPending = false; startBackgroundCull(log); }
    });
    child.unref();
    return true;
  } catch (error) {
    log(`cull worker: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The process lock also covers daemon restarts while its old worker is still running. */
export async function runCullWorker(now = Date.now(), log: (m: string) => void = console.log, freeBytes: FreeBytesReader = statfsFreeBytes): Promise<boolean> {
  const lock = tryDirLock(path.join(lobstahHome(), 'cull-worker.lock'), { staleMs: 1000 });
  if (!lock) return false;
  try {
    for (const id of fs.readdirSync(laneDirs('chore').done)) await releaseReviewWorktree(id, 'chore', log);
    const cfg = loadConfig();
    recoverTrapCaches(cfg, worktreesDir(), freeBytes, log);
    const need = Math.max(cfg.limits.minFreeGB, cfg.limits.cacheMinFreeGB) * GB;
    if (need > 0 && freeBytes(worktreesDir()) < need) {
      cliCuller.pressure(() => freeBytes(worktreesDir()) >= need, now, log);
    }
    retentionPass(cfg, { culler: cliCuller, now: () => now }, log);
    return true;
  } finally {
    lock.release();
  }
}

export const backgroundCuller = {
  ...cliCuller,
  start: startBackgroundCull,
  finished(id: string, log: (m: string) => void) {
    if (storedDescriptor(id, 'chore')?.readOnly) startBackgroundCull(log, true);
  },
};
