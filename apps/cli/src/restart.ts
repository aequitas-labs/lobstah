import * as fs from 'node:fs';
import { activeIds, executorPath } from '@lobstah/core';
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

/** Dispatches the daemon supervises right now: claimed work and chores. */
export function activeDispatchCount(): number {
  return activeIds('work').length + activeIds('chore').length;
}

/**
 * The refusal for a restart that must not run, or undefined when it may.
 * A service that is not installed cannot be restarted by its manager. The
 * daemon supervises active dispatches, so restarting it under them needs
 * --force; queued work is fine, it waits for the new daemon.
 */
export function restartRefusal(opts: { kind: ServiceKind; installed: boolean; active: number; force: boolean }): string | undefined {
  if (!opts.installed) {
    return `the ${opts.kind} service is not installed — install it with \`${INSTALL_COMMAND[opts.kind]}\``;
  }
  if (opts.kind === 'daemon' && opts.active > 0 && !opts.force) {
    return (
      `${opts.active} dispatch(es) active — restarting the daemon interrupts their supervision. ` +
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
  const hb = readHeartbeat();
  const ageSecs = hb ? Math.max(0, Math.round((now - (Date.parse(hb.heartbeat) || 0)) / 1000)) : undefined;
  const fresh = ageSecs !== undefined && ageSecs * 1000 < HEARTBEAT_STALE_MS;
  const running = fresh && (hb?.pid === undefined || pidAlive(hb.pid));
  return {
    daemon: running ? 'running' : 'stopped',
    installed,
    ...(hb?.pid !== undefined ? { pid: hb.pid } : {}),
    ...(hb?.version ? { version: hb.version } : {}),
    heartbeat: ageSecs === undefined ? 'never' : `${ageSecs}s ago`,
    ...(running ? {} : { next: installed ? '`lobstah daemon restart`' : `\`${INSTALL_COMMAND.daemon}\`` }),
  };
}
