import fs from 'node:fs';
import path from 'node:path';
import { lobstahHome, atomicRenameSync, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import { readTrap, hasOpenCatch, type TrapRegistration } from './soak.js';
import { loadConfig } from './config.js';

/** One host UI owner across every grounds on this Mac; it does not lock the person's keyboard. */
interface DesktopLease { trapId: string; sessionId: string; expiresAt: number }
function desktopLeaseFile(): string { return path.join(lobstahHome(), 'desktop-lease.json'); }
function readDesktopLease(): DesktopLease | undefined { try { return JSON.parse(fs.readFileSync(desktopLeaseFile(), 'utf8')) as DesktopLease; } catch { return undefined; } }
function withDesktopLeaseLock<T>(action: () => T): T {
  return withDirLock(`${desktopLeaseFile()}.lock`, action, { staleMs: 30_000, waitMs: 1000, busy: () => new Error('desktop lease is busy; retry') });
}
function writeDesktopLease(registration: TrapRegistration, now: number): void {
  const file = desktopLeaseFile(), temporary = uniqueTempPath(file);
  fs.writeFileSync(temporary, JSON.stringify({ trapId: registration.trapId, sessionId: registration.sessionId, expiresAt: now + loadConfig().soak.ttlSecs * 1000 } satisfies DesktopLease));
  atomicRenameSync(temporary, file);
}

/** A live working owner keeps the UI lease through sleep; an abandoned lease expires with liveness. */
export function acquireDesktopLease(registration: TrapRegistration, now = Date.now()): boolean {
  if (registration.configured?.surface !== 'claude-desktop') return true;
  return withDesktopLeaseLock(() => {
    const lease = readDesktopLease();
    if (lease && (lease.trapId !== registration.trapId || lease.sessionId !== registration.sessionId)) {
      const owner = readTrap(lease.trapId);
      if ((owner?.sessionId === lease.sessionId && (hasOpenCatch(owner) || !!owner.hostedCatch)) || lease.expiresAt > now) return false;
    }
    writeDesktopLease(registration, now); return true;
  });
}

/** Refresh only an already owned lease; a heartbeat never steals another desktop catch's turn. */
export function renewDesktopLease(registration: TrapRegistration, now = Date.now()): void {
  if (registration.configured?.surface !== 'claude-desktop') return;
  withDesktopLeaseLock(() => { const lease = readDesktopLease(); if (lease?.trapId === registration.trapId && lease.sessionId === registration.sessionId) writeDesktopLease(registration, now); });
}

/** Release after a pause, result, stow or ghost so another configured desk can run. */
export function releaseDesktopLease(trapId: string): void {
  withDesktopLeaseLock(() => { if (readDesktopLease()?.trapId === trapId) fs.rmSync(desktopLeaseFile(), { force: true }); });
}
