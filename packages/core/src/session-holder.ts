import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { harnessProcessAlive } from './harness-process.js';
import { validRemoteLink } from './remote-link.js';
import { listRoster } from './roster.js';
import { readSessionWatcher } from './session-watcher.js';
import { listTraps } from './soak.js';

/** A process or trap that still has a harness session open. */
export interface SessionHolder {
  /** The process, when known. */
  pid?: number;
  /** The tmux pane it runs in, when Claude recorded one. */
  pane?: string;
  /** The trap registered or recorded on the session. */
  trap?: string;
  /** Only a listener was found: the session's `soak --wait`, whose own session is still running. */
  listener?: boolean;
}

/** One running Claude process, from the file Claude keeps for it. */
export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  pane?: string;
  /** Its Remote Control session, while connected. Claude clears it on disconnect. */
  bridgeSessionId?: string;
}

const claudeHomeDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Every process's start time as Claude records it: `ps lstart`, in UTC, whatever the machine's zone. */
function utcStartTimes(): Map<number, string> | undefined {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,stat=,lstart='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    const times = new Map<number, string>();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (m && !m[2]!.startsWith('Z')) times.set(Number(m[1]), m[3]!.replace(/\s+/g, ' '));
    }
    return times;
  } catch {
    return undefined;
  }
}

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The running Claude processes on this machine, from the `sessions/<pid>.json`
 * file Claude keeps for each one, in any terminal or pane. A file can outlive
 * its process and a pid can be reused, so the start time must match.
 * Undefined when this Claude keeps no such files.
 */
export function readClaudeProcesses(home = claudeHomeDir()): ClaudeProcess[] | undefined {
  const dir = path.join(home, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  // Windows records its start time in another form, so there the pid is all there is to go on.
  const times = process.platform === 'win32' ? undefined : utcStartTimes();
  const found: ClaudeProcess[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record: { pid?: unknown; sessionId?: unknown; procStart?: unknown; tmux?: unknown; bridgeSessionId?: unknown };
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as typeof record;
    } catch {
      continue;
    }
    const { pid, sessionId } = record;
    if (typeof sessionId !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue;
    if (times) {
      const started = times.get(pid);
      if (started === undefined) continue;
      if (typeof record.procStart === 'string' && record.procStart.replace(/\s+/g, ' ').trim() !== started) continue;
    } else if (!pidRunning(pid)) {
      continue;
    }
    const pane = typeof record.tmux === 'string' ? /%\d+/.exec(record.tmux)?.[0] : undefined;
    found.push({ pid, sessionId, ...(pane ? { pane } : {}), ...(typeof record.bridgeSessionId === 'string' ? { bridgeSessionId: record.bridgeSessionId } : {}) });
  }
  return found;
}

/** The live Claude processes with this session open. */
export function claudeSessionProcesses(sessionId: string, home = claudeHomeDir()): ClaudeProcess[] {
  return (readClaudeProcesses(home) ?? []).filter((p) => p.sessionId === sessionId);
}

/** A process's live URL, as Claude builds it from its Remote Control session id. Not from a local id: those differ. */
export function processRemoteLink(proc: Pick<ClaudeProcess, 'bridgeSessionId'>): string | undefined {
  const link = proc.bridgeSessionId ? `https://claude.ai/code/${proc.bridgeSessionId}` : undefined;
  return validRemoteLink(link) ? link : undefined;
}

/**
 * Everything that still has this session open: a Claude process in any
 * terminal, a process recorded at sign-on by any trap, a trap registered on
 * it, or its listener. A second process on the session would be a second writer.
 */
export function sessionHolders(sessionId: string, opts: { claudeHome?: string } = {}): SessionHolder[] {
  const holders: SessionHolder[] = claudeSessionProcesses(sessionId, opts.claudeHome).map(({ pid, pane }) => ({ pid, ...(pane ? { pane } : {}) }));
  const addProcess = (pid: number, trap?: string) => {
    const known = holders.find((h) => h.pid === pid);
    if (known) {
      if (trap && !known.trap) known.trap = trap;
    } else {
      holders.push({ pid, ...(trap ? { trap } : {}) });
    }
  };
  for (const reg of listTraps()) {
    if (reg.sessionId !== sessionId) continue;
    const trap = reg.name ?? `wt:${reg.trapId}`;
    if (reg.harnessProcess && harnessProcessAlive(reg.harnessProcess)) addProcess(reg.harnessProcess.pid, trap);
    else if (!holders.some((h) => h.trap === trap)) {
      // A trap with no process on record: the one process on its session is its own.
      const unnamed = holders.filter((h) => h.pid !== undefined && !h.trap);
      if (unnamed.length === 1) unnamed[0]!.trap = trap;
      else holders.push({ trap });
    }
  }
  for (const entry of listRoster()) {
    if (entry.sessionId === sessionId && entry.harnessProcess && harnessProcessAlive(entry.harnessProcess)) addProcess(entry.harnessProcess.pid, entry.name);
  }
  // A process found another way explains its own listener.
  if (!holders.some((h) => h.pid !== undefined)) {
    const watcher = readSessionWatcher(sessionId);
    if (watcher) holders.push({ pid: watcher.pid, listener: true, ...(watcher.trapId ? { trap: `wt:${watcher.trapId}` } : {}) });
  }
  return holders;
}

/** Which holders have the session open, and how to stop each. */
export function sessionHolderText(sessionId: string, holders: SessionHolder[]): string {
  const held = holders.map((h) => {
    if (h.listener) return `listener pid ${h.pid}${h.trap ? ` (trap ${h.trap})` : ''}: stop it with \`lobstah soak stop-listener --session ${sessionId}\``;
    if (h.pid === undefined) return `trap ${h.trap}, registered with no known process: \`lobstah stow --wt ${h.trap}\` signs it off`;
    const where = [h.pane ? `tmux pane ${h.pane}` : '', h.trap ? `trap ${h.trap}` : ''].filter(Boolean).join(', ');
    return `process ${h.pid}${where ? ` (${where})` : ''}: type /exit in it, or \`kill ${h.pid}\``;
  });
  return `session ${sessionId.slice(0, 8)} is still open, and a second process would be a second writer. Held by ${held.join('; ')}`;
}

/**
 * The trap a session belongs to in a repo: the one that last signed on with
 * it. Its re-soak restores that trap instead of minting another.
 */
export function rosterTrapForSession(sessionId: string, repo?: string) {
  return listRoster()
    .filter((e) => e.sessionId === sessionId && (repo === undefined || e.repo === repo))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
