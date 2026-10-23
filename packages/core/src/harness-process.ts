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

/** The parent pid and executable name of `pid`, or undefined when it is gone. */
function parentAndName(pid: number): { parent: number; name: string } | undefined {
  if (process.platform === 'win32') {
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ParentProcessId,Name | ConvertTo-Json -Compress`],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    ).trim();
    if (!raw) return undefined;
    const row = JSON.parse(raw) as { ParentProcessId: number; Name: string };
    return { parent: row.ParentProcessId, name: row.Name };
  }
  const raw = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
  const match = /^(\d+)\s+(.+)$/.exec(raw);
  return match ? { parent: Number(match[1]), name: path.basename(match[2]!) } : undefined;
}

/**
 * The nearest ancestor of this process that is a harness CLI, by executable
 * name. Only this invocation's own ancestor chain is read, never a
 * machine-wide process match.
 */
export function harnessAncestorPid(from: number = process.ppid): number | undefined {
  let pid = from;
  for (let hop = 0; hop < 20 && pid > 1; hop++) {
    let row: { parent: number; name: string } | undefined;
    try {
      row = parentAndName(pid);
    } catch {
      return undefined;
    }
    if (!row) return undefined;
    if (HARNESS_NAME.test(row.name)) return pid;
    if (!Number.isSafeInteger(row.parent) || row.parent === pid) return undefined;
    pid = row.parent;
  }
  return undefined;
}

/** When `pid` started, as the OS reports it; undefined when it is not running (an exited, unreaped zombie included). */
export function processStartedAt(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      ).trim();
      return out || undefined;
    }
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(out);
    return match && !match[1]!.startsWith('Z') ? match[2] : undefined;
  } catch {
    return undefined;
  }
}

/** The harness process this sign-on runs in, when one can be found. */
export function captureHarnessProcess(): HarnessProcess | undefined {
  const pid = harnessAncestorPid();
  if (pid === undefined) return undefined;
  const startedAt = processStartedAt(pid);
  return startedAt ? { pid, startedAt } : undefined;
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
