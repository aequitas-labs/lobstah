import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * The harness process (a Codex or Claude Code CLI) a trap session runs in,
 * found at sign-on by walking up from the soak command. Its start time is the
 * identity check: a later signal only reaches the process that signed on,
 * never another process that reused its pid.
 */
export interface HarnessProcess {
  pid: number;
  /** The process start time as the OS reports it; compared as text, never parsed. */
  startedAt: string;
}

/** How a stow left a trap's harness process. */
export type HarnessEnding = 'ended' | 'killed' | 'gone' | 'survived';

const HARNESS_NAME = /^(codex|claude)(\.exe)?$/i;

/** One process as the ancestor walk reads it. */
interface ProcessRow {
  parent: number;
  name: string;
  /** Windows lists the start time with the table; elsewhere it is read for the one process found. */
  startedAt?: string;
}

/**
 * The start time PowerShell prints for a Win32_Process, the same way in the
 * table and for one pid; `-` for a system process that reports none (an
 * error there would fail the whole query).
 */
const WIN_STARTED = "$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '-' })";

/**
 * The whole process table, read once: a walk that queried each hop would
 * start a PowerShell per ancestor on Windows, seconds each.
 */
function processTable(): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) ${WIN_STARTED} $($_.Name)" }`],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+) (\d+) (\S+) (.+)$/.exec(line.trim());
      if (m) rows.set(Number(m[1]), { parent: Number(m[2]), name: m[4]!, ...(m[3] !== '-' ? { startedAt: m[3] } : {}) });
    }
    return rows;
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { parent: Number(m[2]), name: path.basename(m[3]!.trim()) });
  }
  return rows;
}

/** The nearest harness CLI in `from`'s ancestor chain, by executable name, from one table. */
function walkToHarness(table: Map<number, ProcessRow>, from: number): { pid: number; row: ProcessRow } | undefined {
  let pid = from;
  for (let hop = 0; hop < 20 && pid > 1; hop++) {
    const row = table.get(pid);
    if (!row) return undefined;
    if (HARNESS_NAME.test(row.name)) return { pid, row };
    if (!Number.isSafeInteger(row.parent) || row.parent === pid) return undefined;
    pid = row.parent;
  }
  return undefined;
}

/**
 * The nearest ancestor of this process that is a harness CLI, by executable
 * name. Only this invocation's own ancestor chain is followed, never a
 * machine-wide process match.
 */
export function harnessAncestorPid(from: number = process.ppid): number | undefined {
  try {
    return walkToHarness(processTable(), from)?.pid;
  } catch {
    return undefined;
  }
}

/** When `pid` started, as the OS reports it; undefined when it is not running (an exited, unreaped zombie included). */
export function processStartedAt(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue | ForEach-Object { ${WIN_STARTED} }`],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      ).trim();
      return out && out !== '-' ? out : undefined;
    }
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(out);
    return match && !match[1]!.startsWith('Z') ? match[2] : undefined;
  } catch {
    return undefined;
  }
}

/** The harness process this sign-on runs in, when one can be found: one table read, plus one start-time read off Windows. */
export function captureHarnessProcess(): HarnessProcess | undefined {
  let found: { pid: number; row: ProcessRow } | undefined;
  try {
    found = walkToHarness(processTable(), process.ppid);
  } catch {
    return undefined;
  }
  if (!found) return undefined;
  const startedAt = found.row.startedAt ?? processStartedAt(found.pid);
  return startedAt ? { pid: found.pid, startedAt } : undefined;
}

/** True while the recorded process runs: the same pid, started at the same time. */
export function harnessProcessAlive(proc: HarnessProcess): boolean {
  return processStartedAt(proc.pid) === proc.startedAt;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function goneWithin(proc: HarnessProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!harnessProcessAlive(proc)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * End a stowed trap's harness process: SIGINT, then SIGKILL when it is still
 * running after `graceMs`. A process that is gone, or whose pid now names a
 * process started at another time, is left alone.
 */
export async function endHarnessProcess(proc: HarnessProcess, opts: { graceMs?: number } = {}): Promise<HarnessEnding> {
  if (!harnessProcessAlive(proc)) return 'gone';
  try {
    process.kill(proc.pid, 'SIGINT');
  } catch {
    return 'gone';
  }
  if (await goneWithin(proc, opts.graceMs ?? 5_000)) return 'ended';
  try {
    process.kill(proc.pid, 'SIGKILL');
  } catch {
    return 'ended';
  }
  return (await goneWithin(proc, 2_000)) ? 'killed' : 'survived';
}
