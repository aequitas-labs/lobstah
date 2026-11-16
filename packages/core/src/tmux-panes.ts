import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryDirLock } from './dir-lock.js';
import { atomicRenameSync, lobstahHome, readDirIfPresent, uniqueTempPath } from './paths.js';
import { listRoster } from './roster.js';
import { listTraps } from './soak.js';
import type { WindowRef } from './window.js';

/** A command on lobstah's own server; callers cannot supply a different socket. */
export type PaneCleanupRunner = (args: string[]) => string;

/** Pane ownership survives sign-off, a replacement session, and daemon restarts. */
interface TrapPane {
  pane: string;
  trapId: string;
  ended: boolean;
}

const paneId = /^%\d+$/;
const trapId = /^[a-zA-Z0-9-]+$/;
const paneDirectory = (): string => path.join(lobstahHome(), 'tmux-panes');
const paneFile = (pane: string): string => path.join(paneDirectory(), `${pane.slice(1)}.json`);

/** Only a recorded lobstah socket proves ownership; other terminal servers stay untouched. */
export function isLobstahPane(window: WindowRef | undefined): boolean {
  return !!window?.tmuxPane && paneId.test(window.tmuxPane) &&
    !!window.tmuxSocket && path.basename(window.tmuxSocket) === 'lobstah';
}

/** Retain a launched pane even if its process fails before it can sign on. */
export function rememberTrapPane(id: string, window: WindowRef | undefined, ended = false): void {
  if (!trapId.test(id) || !isLobstahPane(window)) return;
  fs.mkdirSync(paneDirectory(), { recursive: true });
  const file = paneFile(window!.tmuxPane!);
  const temp = uniqueTempPath(file);
  fs.writeFileSync(temp, JSON.stringify({ pane: window!.tmuxPane!, trapId: id, ended } satisfies TrapPane));
  atomicRenameSync(temp, file);
}

/** Archived terminal output for one trap, or an unowned pane left by an older launch. */
export function trapPaneLog(id: string): string {
  if (!trapId.test(id)) throw new Error('invalid trap log id');
  return path.join(lobstahHome(), 'logs', 'traps', `${id}.log`);
}

const runTmux: PaneCleanupRunner = (args) => execFileSync('tmux', ['-L', 'lobstah', ...args], {
  encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});

/** Read only complete ownership records; a partial or stale file never names a tmux target. */
function recordedPanes(): TrapPane[] {
  return readDirIfPresent(paneDirectory()).flatMap((file): TrapPane[] => {
    if (!file.endsWith('.json')) return [];
    try {
      const row = JSON.parse(fs.readFileSync(path.join(paneDirectory(), file), 'utf8')) as TrapPane;
      return paneId.test(row.pane) && trapId.test(row.trapId) && typeof row.ended === 'boolean' ? [row] : [];
    } catch { return []; }
  });
}

/**
 * Save the last 200 terminal lines before closing dead panes. Pending departures
 * retry each tick; the slower orphan pass also finds panes from older launches.
 * The placement lock prevents removing a window between its lookup and split.
 * tmux rechecks pane_dead when executing the close, so a respawn stays alive.
 * Capture or log failures leave the pane intact for a later retry.
 */
export function reapDeadTrapPanes(includeOrphans = false, run: PaneCleanupRunner = runTmux): string[] {
  const recorded = recordedPanes();
  if (!includeOrphans && !recorded.some((p) => p.ended)) return [];
  fs.mkdirSync(lobstahHome(), { recursive: true });
  const lock = tryDirLock(path.join(lobstahHome(), 'tmux-placement.lock'), { staleMs: 30_000 });
  if (!lock) return [];
  try {
    let output: string;
    try { output = run(['list-panes', '-a', '-F', '#{pane_id}|#{pane_dead}']); }
    catch { return []; }
    const live = new Set(listTraps().filter((t) => isLobstahPane(t.window)).map((t) => t.window!.tmuxPane!));
    const roster = includeOrphans ? listRoster() : [];
    const present = new Set<string>();
    const reaped: string[] = [];
    for (const line of output.split('\n')) {
      const [pane, dead] = line.split('|');
      if (!pane || !paneId.test(pane)) continue;
      present.add(pane);
      const owner = recorded.find((p) => p.pane === pane);
      if (dead !== '1' || live.has(pane) || (!includeOrphans && !owner?.ended)) continue;
      const prior = roster.find((t) => isLobstahPane(t.window) && t.window!.tmuxPane === pane);
      const id = owner?.trapId ?? prior?.trapId ?? `pane-${pane.slice(1)}`;
      try {
        const captured = run(['capture-pane', '-p', '-t', pane, '-S', '-200']);
        const tail = captured.trimEnd().split('\n').slice(-200).join('\n');
        const file = trapPaneLog(id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `\n--- ${new Date().toISOString()} tmux ${pane} ---\n${tail}\n`);
        const result = run(['if-shell', '-F', '-t', pane, '#{pane_dead}', `kill-pane -t ${pane}`, 'display-message -p pane-running']);
        if (result.trim() === 'pane-running') continue;
        fs.rmSync(paneFile(pane), { force: true });
        reaped.push(pane);
      } catch {
        // A concurrent exit or failed archive must not interrupt trap lifecycle work.
      }
    }
    for (const record of recorded) {
      if (!present.has(record.pane)) fs.rmSync(paneFile(record.pane), { force: true });
    }
    return reaped;
  } finally { lock.release(); }
}

/** Sign-off can precede shell exit: remember it now and let the daemon retry until dead. */
export function retireTrapPane(id: string, window: WindowRef | undefined): void {
  if (!isLobstahPane(window)) return;
  rememberTrapPane(id, window, true);
  reapDeadTrapPanes();
}
