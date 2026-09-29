import { execFileSync } from 'node:child_process';

/** One row of the process table. `pgid` is absent on Windows. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid?: number;
}

/** The process table: `ps` on POSIX, CIM through PowerShell on Windows. */
export function listProcesses(): ProcRow[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
      .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
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
    rows = listProcesses();
  } catch {
    return 0;
  }
  const pids = startedBy(root, rows);
  await stopPids(pids, graceMs);
  return pids.length;
}
