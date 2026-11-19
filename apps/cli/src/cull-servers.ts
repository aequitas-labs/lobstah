import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchWorktree, laneDirs, laneOf, listRoster, loadConfig, readStatusLog, soakingDir, toonTable, worktreesDir, type Config, type TrapRegistration } from '@lobstah/core';
import { serverRuntime, type ServerInventory, type ServerProcess, type ServerRuntime } from './cull-server-inventory.js';

const HOUR = 3_600_000;

/** Parent directory of worktrees, with different idle rules for lobstah-owned checkouts. */
export interface ServerWorktreeRoot { directory: string; lobstah: boolean }

/** A preview row also retains the identities needed to recheck an apply. */
export interface ServerCullItem {
  kind: 'server' | 'container' | 'tmux';
  id: string;
  pid?: number;
  ports: number[];
  worktrees: string[];
  ageHours: number;
  action: string;
  reason?: string;
  processes: ServerProcess[];
  groupId?: number;
  startedAt: string;
}

/** Inject filesystem/liveness reads independently of OS effects. */
export interface ServerCullOptions {
  idleHours?: number;
  graceSeconds?: number;
  now?: number;
  roots?: ServerWorktreeRoot[];
  busyWorktrees?: () => string[];
  lastEdit?: (worktree: string) => number;
  protectedPids?: number[];
}

/** Resolve aliases before comparing path components, so symlinks cannot escape the scope. */
function canonical(directory: string): string {
  const expanded = directory.startsWith('~/') ? path.join(os.homedir(), directory.slice(2)) : directory;
  try { return fs.realpathSync.native(expanded); }
  catch { return path.resolve(expanded); }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Defaults always remain in scope; configured roots add other agent checkout locations. */
export function serverWorktreeRoots(config: Config = loadConfig()): ServerWorktreeRoot[] {
  return [
    { directory: worktreesDir(), lobstah: true },
    ...[path.join(os.homedir(), '.codex/worktrees'), ...Object.values(config.repos).map((repo) => path.join(repo.path, '.claude/worktrees')), ...(config.cull?.worktreeRoots ?? [])]
      .map((directory) => ({ directory: canonical(directory), lobstah: false })),
  ];
}

/** Locate a checkout below a configured parent, including Codex's <id>/<repo> nesting. */
export function serverWorktree(directory: string, roots: ServerWorktreeRoot[]): { directory: string; lobstah: boolean } | undefined {
  const cwd = canonical(directory);
  for (const root of [...roots].sort((a, b) => canonical(b.directory).length - canonical(a.directory).length)) {
    const parent = canonical(root.directory);
    if (!inside(parent, cwd)) continue;
    const firstChild = path.join(parent, path.relative(parent, cwd).split(path.sep)[0]!);
    for (let current = cwd; inside(parent, current); current = path.dirname(current)) {
      try {
        if (fs.lstatSync(path.join(current, '.git')).isFile()) return { directory: current, lobstah: root.lobstah };
      } catch { /* A cwd below a checkout has no .git of its own. */ }
    }
    return { directory: firstChild, lobstah: root.lobstah };
  }
  return undefined;
}

/** A live claim with missing state is busy; a parked unclaimed trap is idle. */
export function busyServerWorktrees(): string[] {
  // Unlike the display reader, fail closed on corrupt or unreadable registrations.
  const traps = fs.readdirSync(soakingDir()).filter((name) => name.endsWith('.json')).map((name) => {
    const trap = JSON.parse(fs.readFileSync(path.join(soakingDir(), name), 'utf8')) as TrapRegistration;
    if (!trap || typeof trap.worktree !== 'string') throw new Error('Could not read trap worktree state; services kept.');
    return trap;
  });
  const busy = traps.filter((trap) => {
    if (!trap.claimed) return !trap.parkedAt;
    const lane = laneOf(trap.claimed);
    const verb = lane ? readStatusLog(trap.claimed, lane).at(-1)?.verb : undefined;
    return verb === undefined || verb === 'working';
  }).map((trap) => trap.worktree);
  // Headless runners have no soaking registration, but still own their active checkout.
  for (const lane of ['work', 'chore'] as const) {
    for (const id of fs.readdirSync(laneDirs(lane).active)) {
      if (traps.some((trap) => trap.claimed === id)) continue;
      const verb = readStatusLog(id, lane).at(-1)?.verb;
      if (verb === undefined || verb === 'working') busy.push(dispatchWorktree(id, lane).path);
    }
  }
  return [...new Set(busy)];
}

/** Newest file or directory edit; never follow symlinks into another checkout. */
export function latestWorktreeEdit(directory: string): number {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) return stat.mtimeMs;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(directory).reduce((latest, name) => Math.max(latest, latestWorktreeEdit(path.join(directory, name))), stat.mtimeMs);
}

/** Agents, infrastructure and the caller's ancestors can never be signal targets. */
function protectedProcess(row: ServerProcess, protectedPids: Set<number>): boolean {
  if (row.pid <= 1 || protectedPids.has(row.pid)) return true;
  const words = row.command.split(/\s+/).map((word) => path.basename(word.replace(/^["']|["']$/g, '')));
  return words.some((word) => /^(?:codex|claude)(?:[.\-].*)?$|^(?:lobstah|docker|dockerd|containerd|tmux:?|com\.docker\..*|Docker)(?:\.exe)?$/i.test(word)) ||
    /(?:(?:^|\/)(?:codex|claude)(?:[.\-\/]|\s|$)|@anthropic-ai\/claude-code|@openai\/codex|(?:^|\s)(?:glass|daemon)(?:\s|$)|lobstah\/apps\/cli\/dist\/main\.js)/i.test(row.command);
}

function protectedProcessIds(processes: ServerProcess[], extra: number[]): Set<number> {
  const ids = new Set([process.pid, ...extra, ...listRoster().flatMap((trap) => trap.harnessProcess ? [trap.harnessProcess.pid] : [])]);
  let pid = process.ppid;
  while (pid > 1 && !ids.has(pid)) {
    ids.add(pid);
    pid = processes.find((row) => row.pid === pid)?.parentPid ?? 0;
  }
  return ids;
}

function descendants(processes: ServerProcess[], pid: number): ServerProcess[] {
  const ids = new Set([pid]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const row of processes) if (ids.has(row.parentPid)) ids.add(row.pid);
  }
  return processes.filter((row) => ids.has(row.pid));
}

/** Plan only scoped listeners/containers. Kept scoped items explain their safety gate. */
export function planServerCull(inventory: ServerInventory, options: ServerCullOptions = {}): ServerCullItem[] {
  const idleHours = options.idleHours ?? 12;
  if (!Number.isFinite(idleHours) || idleHours < 0) throw new Error('--idle-hours must be a non-negative number');
  const now = options.now ?? Date.now();
  const roots = options.roots ?? serverWorktreeRoots();
  const busy = (options.busyWorktrees ?? busyServerWorktrees)().map(canonical);
  const protectedPids = protectedProcessIds(inventory.processes, options.protectedPids ?? []);
  const edits = new Map<string, number>();
  const keepReason = (directories: string[]): string | undefined => {
    for (const directory of directories) {
      if (busy.some((worktree) => worktree === directory || inside(directory, worktree) || inside(worktree, directory))) return 'worktree is busy';
      if (!serverWorktree(directory, roots)?.lobstah) {
        try {
          if (!edits.has(directory)) edits.set(directory, (options.lastEdit ?? latestWorktreeEdit)(directory));
          if (!Number.isFinite(edits.get(directory))) return 'could not read worktree edits';
          if (now - edits.get(directory)! < idleHours * HOUR) return `edited within ${idleHours}h`;
        } catch { return 'could not read worktree edits'; }
      }
    }
    return undefined;
  };
  const scope = (row: ServerProcess): string | undefined => row.cwd ? serverWorktree(row.cwd, roots)?.directory : undefined;
  const items: ServerCullItem[] = [];
  const grouped = new Set<number>();
  for (const row of inventory.processes.filter((row) => row.ports.length)) {
    const worktree = scope(row);
    if (!worktree || grouped.has(row.pid)) continue;
    const group = inventory.processes.filter((member) => member.groupId === row.groupId);
    const safeGroup = row.groupId > 1 && group.length > 0 && group.every((member) => scope(member) === worktree && !protectedProcess(member, protectedPids));
    const members = safeGroup ? group : [row];
    const reason = protectedProcess(row, protectedPids) ? 'agent or infrastructure process' : keepReason([worktree]);
    for (const member of members) grouped.add(member.pid);
    items.push({ kind: 'server', id: String(row.pid), pid: row.pid, worktrees: [worktree],
      ports: [...new Set(members.flatMap((member) => member.ports))].sort((a, b) => a - b),
      ageHours: Math.max(0, Math.floor((now - Date.parse(row.startedAt + ' UTC')) / HOUR)),
      action: reason ? 'keep' : 'stop', reason, processes: members, startedAt: row.startedAt,
      groupId: safeGroup ? row.groupId : undefined,
    });
  }
  for (const container of inventory.containers) {
    const sources = [container.workingDirectory, ...container.bindSources].filter((source): source is string => !!source);
    const worktrees = [...new Set(sources.flatMap((source) => { const worktree = serverWorktree(source, roots); return worktree ? [worktree.directory] : []; }))];
    if (!worktrees.length) continue;
    const reason = /(?:^|[-_])(?:lobstah|glass|daemon)(?:[-_]|$)/i.test(container.name) ? 'infrastructure container' : keepReason(worktrees);
    items.push({ kind: 'container', id: container.id, ports: container.ports, worktrees,
      ageHours: Math.max(0, Math.floor((now - Date.parse(container.startedAt)) / HOUR)),
      action: reason ? 'keep' : 'stop', reason, processes: [], startedAt: container.startedAt,
    });
  }
  for (const session of new Set(inventory.panes.map((pane) => pane.session))) {
    const panes = inventory.panes.filter((pane) => pane.session === session);
    const members = inventory.processes.filter((row) => panes.some((pane) => descendants(inventory.processes, pane.pid).some((child) => child.pid === row.pid)));
    const directories = [...new Set(members.map(scope))];
    // Close only dedicated server sessions: every pane owns a scoped listener and no agent.
    if (directories.length !== 1 || !directories[0] || members.some((row) => protectedProcess(row, protectedPids)) ||
        panes.some((pane) => !descendants(inventory.processes, pane.pid).some((row) => row.ports.length))) continue;
    const reason = keepReason([directories[0]]);
    const shell = inventory.processes.find((row) => row.pid === panes[0]!.pid);
    if (!shell) continue;
    items.push({ kind: 'tmux', id: session, pid: shell.pid, ports: [...new Set(members.flatMap((row) => row.ports))],
      worktrees: [directories[0]], ageHours: Math.max(0, Math.floor((now - Date.parse(shell.startedAt + ' UTC')) / HOUR)),
      action: reason ? 'keep' : 'close', reason, processes: members, startedAt: shell.startedAt,
    });
  }
  return items;
}

/** Stable user output shared by fixture samples and the CLI's dry run. */
export function formatServerCull(items: ServerCullItem[]): string {
  return toonTable('servers', items.map((item) => ({
    kind: item.kind, id: item.id, port: item.ports.join(',') || '-', pid: item.pid ?? '-',
    worktree: item.worktrees.join(','), ageHours: item.ageHours, action: item.reason ? `${item.action}: ${item.reason}` : item.action,
  })), ['kind', 'id', 'port', 'pid', 'worktree', 'ageHours', 'action']);
}

function sameProcess(left: ServerProcess, right: ServerProcess): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.groupId === right.groupId && left.command === right.command && left.cwd === right.cwd;
}

/** Recheck scope, busy state, identities and all group members before each signal. */
function signalStillSafe(item: ServerCullItem, current: ServerInventory, options: ServerCullOptions): boolean {
  const protectedPids = protectedProcessIds(current.processes, options.protectedPids ?? []);
  const remaining = item.groupId === undefined ? current.processes.filter((row) => row.pid === item.pid) : current.processes.filter((row) => row.groupId === item.groupId);
  if (!remaining.length || remaining.some((row) => protectedProcess(row, protectedPids) || !item.processes.some((original) => sameProcess(row, original)))) return false;
  // Preserve the original listener selection even after SIGTERM closes its socket.
  const check: ServerInventory = { ...current, containers: [], panes: [], processes: remaining.map((row) => ({ ...row, ports: [item.ports[0] ?? 1] })) };
  const rows = planServerCull(check, options);
  return rows.length > 0 && rows.every((row) => !row.reason && row.worktrees.every((directory) => item.worktrees.includes(directory)));
}

/** Stop servers before disk cleanup. Dry runs perform no signals or Docker/tmux mutations. */
export async function runServerCull(apply: boolean, options: ServerCullOptions = {}, runtime: ServerRuntime = serverRuntime): Promise<string> {
  const grace = options.graceSeconds ?? 5;
  if (!Number.isFinite(grace) || grace < 0 || grace > 60) throw new Error('Server stop grace must be between 0 and 60 seconds');
  const initial = runtime.inspect();
  const items = planServerCull(initial, options);
  if (!apply) return [formatServerCull(items), ...initial.warnings, ...(items.some((item) => !item.reason) ? ['dry run — pass --apply to stop'] : [])].join('\n');
  const signalled: ServerCullItem[] = [];
  for (const item of items.filter((item) => !item.reason && item.kind !== 'tmux')) {
    const current = runtime.inspect();
    if (item.kind === 'container') {
      const fresh = planServerCull(current, options).find((row) => row.kind === item.kind && row.id === item.id && row.startedAt === item.startedAt);
      if (!fresh || fresh.reason || fresh.worktrees.join('\0') !== item.worktrees.join('\0')) { item.action = 'keep'; item.reason = fresh?.reason ?? 'container changed since inspection'; continue; }
      try { runtime.stopContainer(item.id, grace); item.action = 'docker stop'; }
      catch { item.action = 'keep'; item.reason = 'docker stop failed'; }
    } else {
      if (!signalStillSafe(item, current, options)) { item.action = 'keep'; item.reason = 'process or worktree changed since inspection'; continue; }
      try { runtime.signal(item.groupId === undefined ? item.pid! : -item.groupId, 'SIGTERM'); item.action = 'SIGTERM'; signalled.push(item); }
      catch { item.action = 'keep'; item.reason = 'could not send SIGTERM'; }
    }
  }
  if (signalled.length) await runtime.wait(grace * 1000);
  for (const item of signalled) {
    const current = runtime.inspect();
    if (!signalStillSafe(item, current, options)) continue;
    try { runtime.signal(item.groupId === undefined ? item.pid! : -item.groupId, 'SIGKILL'); item.action = 'SIGTERM, SIGKILL'; }
    catch { item.action = 'SIGTERM; SIGKILL failed'; }
  }
  for (const item of items.filter((item) => item.kind === 'tmux' && !item.reason)) {
    const current = runtime.inspect();
    const panes = current.panes.filter((pane) => pane.session === item.id);
    const members = panes.flatMap((pane) => descendants(current.processes, pane.pid));
    const shellSurvives = panes.length > 0 && panes.every((pane) => members.some((row) => row.pid === pane.pid && item.processes.some((original) => sameProcess(row, original))));
    // A newly opened pane or process makes this a different session; leave it alone.
    if (!shellSurvives || members.some((row) => !item.processes.some((original) => sameProcess(row, original))) ||
        !signalStillSafe({ ...item, groupId: undefined }, current, options)) {
      item.action = 'keep'; item.reason = 'session or worktree changed since inspection'; continue;
    }
    try { runtime.closeSession(item.id); item.action = 'close session'; }
    catch { item.action = 'keep'; item.reason = 'could not close session'; }
  }
  return [formatServerCull(items), ...initial.warnings].join('\n');
}
