import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
/** Inspect only this invocation's ancestor chain, never a fleet-wide process match. */
export function wharfSessionPid(): number {
  const wrapper = Number(process.env.LOBSTAH_WHARF_SESSION_PID);
  if (Number.isSafeInteger(wrapper) && wrapper > 1) return wrapper;
  let pid = process.ppid;
  for (let hop = 0; hop < 20 && pid > 1; hop++) {
    try {
      let parent: number, name: string;
      if (process.platform === 'win32') {
        const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ParentProcessId,Name | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 3000 });
        const row = JSON.parse(raw); parent = row.ParentProcessId; name = row.Name;
      } else {
        const raw = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
        const match = /^(\d+)\s+(.+)$/.exec(raw); if (!match) break;
        parent = Number(match[1]); name = path.basename(match[2]!);
      }
      if (/^(codex|claude)(\.exe)?$/i.test(name)) return pid;
      if (!Number.isSafeInteger(parent) || parent === pid) break;
      pid = parent;
    } catch { break; }
  }
  throw new Error('cannot identify the live harness process; start this hosted trap with lobstah man throw --new, or soak from a Claude/Codex session');
}
