import { execFileSync } from 'node:child_process';
import { endHarnessProcess, listTraps, processStartedAt, type TrapRegistration } from '@lobstah/core';
import { tmuxRunner, type TmuxRunner } from './tmux-terminal.js';

/** One pane on lobstah's tmux server. */
export interface PaneInfo {
  pane: string;
  dead: boolean;
  /** The pane's own process (its shell, or the command it runs). */
  pid: number;
  /** lobstah titles a trap's pane `<repo> · <trap>`; tmux may show the dot as `_`. */
  title: string;
}

/** One running process, from `ps`. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** The Codex thread a process has open, and whether it holds the thread's writer lock. */
export interface ThreadUse {
  threadId: string;
  writer: boolean;
}

/** What tidying does to one pane, and why. */
export type PaneTidy =
  | { pane: string; title: string; action: 'close'; why: string }
  | { pane: string; title: string; action: 'stop'; codexPid: number; why: string }
  | { pane: string; title: string; action: 'keep'; why: string };

/** The trap a pane's title names: the word after its last separator. */
export function paneTrapName(title: string): string | undefined {
  const m = /(?:·|_)\s*([a-z]+-[a-z]+)\s*$/.exec(title.trim());
  return m?.[1];
}

/** Codex's processes under one pane: the outermost (the one to stop) and every one (to read their threads). */
function codexUnder(rootPid: number, procs: ProcInfo[]): { outermost: number[]; all: number[] } {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const isCodex = (command: string) => /(^|\/)(codex(\.js)?|codex-[a-z-]+)(\s|$)/.test(command);
  const outermost: number[] = [];
  const all: number[] = [];
  const visit = (proc: ProcInfo, inCodex: boolean): void => {
    const codex = isCodex(proc.command);
    if (codex) {
      all.push(proc.pid);
      if (!inCodex) outermost.push(proc.pid);
    }
    for (const child of children.get(proc.pid) ?? []) visit(child, inCodex || codex);
  };
  // tmux may run Codex as the pane's own process, or under a shell.
  const root = procs.find((p) => p.pid === rootPid);
  if (root) visit(root, false);
  return { outermost, all };
}

/**
 * Which panes to tidy, so each trap keeps one live Codex pane. A dead pane
 * closes. A live trap's own pane (the one it recorded at sign-on) stays. Any
 * other Codex pane named for a live trap is a duplicate, and one named for a
 * trap that is no longer signed on is a leftover: each stops and closes, as
 * left running it holds a thread a new pane would show "open in another app"
 * for. The thread decides it, not the title alone: a pane whose Codex holds
 * the writer lock of a live trap's thread is that trap's writer, so it stays
 * whatever its title says. Panes running anything but Codex are left alone.
 */
export function planPaneTidy(
  panes: PaneInfo[],
  procs: ProcInfo[],
  traps: Pick<TrapRegistration, 'name' | 'sessionId' | 'window'>[],
  threadOf: (pid: number) => ThreadUse | undefined,
): PaneTidy[] {
  const plan: PaneTidy[] = [];
  const liveThreads = new Set(traps.map((t) => t.sessionId));
  for (const p of panes) {
    if (p.dead) {
      plan.push({ pane: p.pane, title: p.title, action: 'close', why: 'its process has exited' });
      continue;
    }
    const codex = codexUnder(p.pid, procs);
    if (codex.outermost.length === 0) continue;
    const name = paneTrapName(p.title);
    const trap = name ? traps.find((t) => t.name === name) : undefined;
    if (trap?.window?.tmuxPane === p.pane) continue;
    const writes = codex.all.map(threadOf).find((use) => use?.writer && liveThreads.has(use.threadId));
    if (writes) {
      plan.push({ pane: p.pane, title: p.title, action: 'keep', why: `its Codex writes live thread ${writes.threadId.slice(0, 8)}; check which pane that trap should use` });
      continue;
    }
    if (!name) continue;
    const why = trap ? `a duplicate of ${name}, whose own pane is ${trap.window?.tmuxPane ?? 'unrecorded'}` : `a leftover of ${name}, which is not signed on`;
    for (const pid of codex.outermost) plan.push({ pane: p.pane, title: p.title, action: 'stop', codexPid: pid, why });
  }
  return plan;
}

const FIELD = '|';

/** lobstah's panes, or [] when its tmux server isn't running. */
export async function listLobstahPanes(run: TmuxRunner = tmuxRunner()): Promise<PaneInfo[]> {
  let out: string;
  try {
    out = await run(['list-panes', '-a', '-F', ['#{pane_id}', '#{pane_dead}', '#{pane_pid}', '#{pane_title}'].join(FIELD)]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [pane, dead, pid, ...title] = line.split(FIELD);
      return { pane: pane!, dead: dead === '1', pid: Number(pid), title: title.join(FIELD) };
    });
}

/** Every running process with its parent and argv. */
export function listProcesses(): ProcInfo[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The Codex thread a process has open, read from its open files: its writer lock, else its transcript. */
export function codexThreadOf(pid: number): ThreadUse | undefined {
  let out: string;
  try {
    out = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
  const lock = new RegExp(`thread-writer-locks/(${UUID})\\.lock$`, 'm').exec(out);
  if (lock) return { threadId: lock[1]!, writer: true };
  const rollout = new RegExp(`rollout-[^/\\n]*-(${UUID})\\.jsonl$`, 'm').exec(out);
  return rollout ? { threadId: rollout[1]!, writer: false } : undefined;
}

/** Carry out a tidy plan: stop each duplicate's or leftover's Codex, then close its pane. */
export async function applyPaneTidy(plan: PaneTidy[], run: TmuxRunner = tmuxRunner()): Promise<string[]> {
  const done: string[] = [];
  const kept = new Set<string>();
  for (const step of plan) {
    if (step.action === 'keep') continue;
    if (step.action === 'stop') {
      const startedAt = processStartedAt(step.codexPid);
      const ending = startedAt ? await endHarnessProcess({ pid: step.codexPid, startedAt }) : 'gone';
      if (ending === 'survived') {
        kept.add(step.pane);
        done.push(`${step.pane}: Codex ${step.codexPid} survived SIGKILL; pane kept`);
        continue;
      }
    }
    if (kept.has(step.pane)) continue;
    try {
      await run(['kill-pane', '-t', step.pane]);
      done.push(`${step.pane}: closed (${step.why})`);
    } catch (error) {
      // A pane with two Codex processes is closed with the first.
      if (!/can't find pane/i.test(String(error))) done.push(`${step.pane}: could not close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
}

/** `lobstah man tidy-panes`: the plan for lobstah's tmux server, carried out with `apply`. */
export async function tidyPanes(apply: boolean): Promise<{ plan: PaneTidy[]; done: string[] }> {
  const plan = planPaneTidy(await listLobstahPanes(), listProcesses(), listTraps(), codexThreadOf);
  return { plan, done: apply ? await applyPaneTidy(plan) : [] };
}
