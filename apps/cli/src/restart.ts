import * as fs from 'node:fs';
import { executorPath, slotUsage } from '@lobstah/core';
import type { ServiceKind } from './service.js';

/** How long a restart waits for the new process to show itself. */
export const RESTART_WAIT_MS = 10_000;

/** A heartbeat older than this means the daemon is down (doctor and tend agree). */
export const HEARTBEAT_STALE_MS = 90_000;

/** The command that installs a service, for the not-installed message. */
export const INSTALL_COMMAND: Record<ServiceKind, string> = {
  daemon: 'lobstah daemon install',
  pick: 'lobstah pick install',
  glass: 'lobstah glass install',
};

/** The daemon supervises only headless runners; trap catches survive its restart. */
export function activeDispatchCounts(): { headless: number; traps: number } {
  const work = slotUsage('work');
  const chore = slotUsage('chore');
  return { headless: work.headless + chore.headless, traps: work.traps + chore.traps };
}

export function activeDispatchCount(): number {
  return activeDispatchCounts().headless;
}

/**
 * The refusal for a restart that must not run, or undefined when it may.
 * A service that is not installed cannot be restarted by its manager. The
 * daemon supervises headless active dispatches, so restarting it under them
 * needs --force. Trap catches keep running in their own sessions.
 */
export function restartRefusal(opts: { kind: ServiceKind; installed: boolean; active: number; traps?: number; force: boolean }): string | undefined {
  if (!opts.installed) {
    return `the ${opts.kind} service is not installed — install it with \`${INSTALL_COMMAND[opts.kind]}\``;
  }
  if (opts.kind === 'daemon' && opts.active > 0 && !opts.force) {
    return (
      `${opts.active} headless dispatch(es) and ${opts.traps ?? 0} trap catch(es) active — restarting the daemon interrupts headless supervision only. ` +
      'Wait for them to finish, or pass --force.'
    );
  }
  return undefined;
}

export interface Heartbeat {
  heartbeat: string;
  version?: string;
  pid?: number;
}

export function readHeartbeat(): Heartbeat | undefined {
  try {
    const hb = JSON.parse(fs.readFileSync(executorPath(), 'utf8')) as Partial<Heartbeat>;
    return typeof hb.heartbeat === 'string' ? (hb as Heartbeat) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait until a new daemon writes its heartbeat: at or after `sinceMs`, and
 * from a different pid than the old daemon when both are known.
 */
export async function awaitHeartbeat(sinceMs: number, oldPid?: number, timeoutMs = RESTART_WAIT_MS): Promise<Heartbeat | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hb = readHeartbeat();
    const fresh = hb && (Date.parse(hb.heartbeat) || 0) >= sinceMs;
    if (fresh && (oldPid === undefined || hb.pid === undefined || hb.pid !== oldPid)) return hb;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `lobstah daemon status`: installed, running, pid, version, heartbeat age. */
export function daemonStatus(installed: boolean, now = Date.now()): Record<string, string | number | boolean> {
  const usage = activeDispatchCounts();
  const hb = readHeartbeat();
  const ageSecs = hb ? Math.max(0, Math.round((now - (Date.parse(hb.heartbeat) || 0)) / 1000)) : undefined;
  const fresh = ageSecs !== undefined && ageSecs * 1000 < HEARTBEAT_STALE_MS;
  const running = fresh && (hb?.pid === undefined || pidAlive(hb.pid));
  return {
    daemon: running ? 'running' : 'stopped',
    installed,
    headless: usage.headless,
    trapCatches: usage.traps,
    ...(hb?.pid !== undefined ? { pid: hb.pid } : {}),
    ...(hb?.version ? { version: hb.version } : {}),
    heartbeat: ageSecs === undefined ? 'never' : `${ageSecs}s ago`,
    ...(running ? {} : { next: installed ? '`lobstah daemon restart`' : `\`${INSTALL_COMMAND.daemon}\`` }),
  };
}
