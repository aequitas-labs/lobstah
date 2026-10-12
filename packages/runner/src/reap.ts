import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { WINDOWS_PROCESS_SNAPSHOT } from './windows-processes.js';

const run = promisify(execFile);

/** One row of the process table. `pgid` is absent on Windows. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid?: number;
}

/** How long the process table may take to read, on any platform. */
const LIST_MS = 30_000;

/**
 * Run `start` within `totalMs`, in two halves: a start that is still running
 * at half time is stopped and started once more. The first PowerShell start
 * on a Windows machine since it booted is about ten times slower than later
 * ones (about 3 s against 0.4 s on CI runners), and on a busy runner it has
 * outlasted the whole bound, after which the next start finished in time.
 */
export async function startTwice<T>(start: (timeoutMs: number) => Promise<T>, totalMs = LIST_MS): Promise<T> {
  try {
    return await start(totalMs / 2);
  } catch (err) {
    // execFile sets `killed` when its timeout stopped the process.
    if (!(err as { killed?: boolean }).killed) throw err;
    return start(totalMs / 2);
  }
}

/**
 * The process table: `ps` on POSIX, a native Tool Help snapshot on Windows.
 * It does not block the event loop while the command runs.
 */
export async function listProcesses(): Promise<ProcRow[]> {
  if (process.platform === 'win32') {
    const { stdout } = await startTwice((timeout) =>
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SNAPSHOT], { encoding: 'utf8', windowsHide: true, timeout }),
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
      .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: LIST_MS });
  return stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, pgid]) => Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid))
    .map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid! }));
}

/**
 * The processes `root` started: every descendant, and, when `root` leads its
 * process group, every other member of that group. A group member whose
 * parent already exited is still in the group. `root` itself is never listed.
 */
export function startedBy(root: number, rows: ProcRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const found = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (child === root || found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  const leads = rows.find((r) => r.pid === root)?.pgid === root;
  if (leads) for (const r of rows) if (r.pgid === root && r.pid !== root) found.add(r.pid);
  return [...found];
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Stop `pids`. On Windows, `taskkill /T /F` stops each process and its tree.
 * On POSIX, SIGTERM first, then SIGKILL for any still alive after `graceMs`.
 */
export async function stopPids(pids: number[], graceMs = 2000): Promise<void> {
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
      } catch {
        // already gone
      }
    }
    return;
  }
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  for (const pid of pids) signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) signal(pid, 'SIGKILL');
}

/**
 * Stop every process `root` started (see `startedBy`) and return how many.
 * A process table that cannot be read stops nothing.
 */
export async function reapStarted(root: number = process.pid, graceMs?: number): Promise<number> {
  let rows: ProcRow[];
  try {
    rows = await listProcesses();
  } catch {
    return 0;
  }
  const pids = startedBy(root, rows);
  await stopPids(pids, graceMs);
  return pids.length;
}
