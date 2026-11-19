import { execFileSync } from 'node:child_process';

/** A process identity and its listening TCP ports, from one OS snapshot. */
export interface ServerProcess {
  pid: number;
  parentPid: number;
  groupId: number;
  startedAt: string;
  command: string;
  cwd?: string;
  ports: number[];
}

/** Running container metadata; only host bind mounts establish ownership. */
export interface WorktreeContainer {
  id: string;
  name: string;
  startedAt: string;
  workingDirectory?: string;
  bindSources: string[];
  ports: number[];
}

/** A tmux pane's owning shell, without touching the tmux server process. */
export interface ServerPane { session: string; pid: number }

/** Inspection failures are visible and never authorize stopping an unknown target. */
export interface ServerInventory {
  processes: ServerProcess[];
  containers: WorktreeContainer[];
  panes: ServerPane[];
  warnings: string[];
}

/** All external effects are injected so tests never inspect or signal real processes. */
export interface ServerRuntime {
  inspect(): ServerInventory;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  stopContainer(id: string, graceSeconds: number): void;
  closeSession(session: string): void;
  wait(ms: number): Promise<void>;
}

/** Run bounded, read-only inventory commands without a shell. */
function read(command: string, args: string[], timeout = 10_000): string {
  return execFileSync(command, args, {
    encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
}

/** lsof returns 1 for an empty selection; other failures must remain visible. */
function lsof(args: string[]): string {
  try { return read('lsof', args); }
  catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (failure.status === 1 && !String(failure.stderr ?? '').trim()) return String(failure.stdout ?? '');
    throw error;
  }
}

/** Parse field-mode lsof output, including cwd paths containing spaces. */
export function parseLsof(output: string): Map<number, string[]> {
  const fields = new Map<number, string[]>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); fields.set(pid, []); }
    else if (pid && line.startsWith('n')) fields.get(pid)!.push(line.slice(1));
  }
  return fields;
}

/** Parse the portable macOS/Linux ps columns; retain the OS start time as identity. */
export function parseServerProcesses(output: string, cwdOutput: string, listenerOutput: string): ServerProcess[] {
  const directories = parseLsof(cwdOutput);
  const listeners = parseLsof(listenerOutput);
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    return [{ pid, parentPid: Number(match[2]), groupId: Number(match[3]), startedAt: match[4]!, command: match[5]!,
      cwd: directories.get(pid)?.[0],
      ports: [...new Set((listeners.get(pid) ?? []).flatMap((address) => {
        const port = /:(\d+)$/.exec(address)?.[1];
        return port ? [Number(port)] : [];
      }))].sort((a, b) => a - b),
    }];
  });
}

interface DockerInspection {
  Id: string;
  Name: string;
  State: { Running: boolean; StartedAt: string };
  Config?: { Labels?: Record<string, string> };
  Mounts?: { Type: string; Source: string }[];
  NetworkSettings?: { Ports?: Record<string, { HostPort: string }[] | null> };
}

/** Convert docker inspect JSON; named volumes and container-internal working dirs prove nothing. */
export function parseWorktreeContainers(output: string): WorktreeContainer[] {
  return (JSON.parse(output) as DockerInspection[]).filter((item) => item.State.Running).map((item) => ({
    id: item.Id, name: item.Name.replace(/^\//, ''), startedAt: item.State.StartedAt,
    workingDirectory: item.Config?.Labels?.['com.docker.compose.project.working_dir'],
    bindSources: (item.Mounts ?? []).filter((mount) => mount.Type === 'bind').map((mount) => mount.Source),
    ports: [...new Set(Object.values(item.NetworkSettings?.Ports ?? {}).flatMap((bindings) => (bindings ?? []).map((binding) => Number(binding.HostPort))))],
  }));
}

/** Production effects. Windows keeps process cleanup disabled; Docker inspection still works. */
export const serverRuntime: ServerRuntime = {
  inspect() {
    const inventory: ServerInventory = { processes: [], containers: [], panes: [], warnings: [] };
    if (process.platform === 'win32') inventory.warnings.push('Server process inspection is unavailable on Windows.');
    else {
      try {
        inventory.processes = parseServerProcesses(
          read('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,command=']),
          lsof(['-nP', '-d', 'cwd', '-Fpn']),
          lsof(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
        );
      } catch { inventory.warnings.push('Could not inspect listening servers; processes kept.'); }
      try {
        inventory.panes = read('tmux', ['list-panes', '-a', '-F', '#{session_id}\t#{pane_pid}']).trim().split('\n').flatMap((line) => {
          const match = /^(\$\d+)\t(\d+)$/.exec(line);
          return match ? [{ session: match[1]!, pid: Number(match[2]) }] : [];
        });
      } catch { /* tmux is optional; process groups can still be stopped safely. */ }
    }
    try {
      const ids = read('docker', ['ps', '-q', '--no-trunc']).trim().split(/\s+/).filter(Boolean);
      if (ids.length) inventory.containers = parseWorktreeContainers(read('docker', ['inspect', ...ids]));
    } catch { inventory.warnings.push('Could not inspect Docker containers; containers kept.'); }
    return inventory;
  },
  signal(pid, signal) { process.kill(pid, signal); },
  stopContainer(id, graceSeconds) { read('docker', ['stop', '--time', String(graceSeconds), id], (graceSeconds + 10) * 1000); },
  closeSession(session) { read('tmux', ['kill-session', '-t', session]); },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
