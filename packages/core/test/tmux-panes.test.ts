import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTempDir } from '../../../test/temp-dir.js';

const terminal = vi.hoisted(() => ({ run: vi.fn<(args: string[]) => string>() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn((command, args, options) => command === 'tmux'
    ? terminal.run(args as string[])
    : actual.execFileSync(command, args, options)) };
});
import {
  ensureLayout, heartbeatTrap, readTrap, reapDeadTrapPanes, rememberTrapPane,
  signOnTrap, stowTrap, sweepGhostTraps, trapPaneLog, type WindowRef,
} from '../src/index.js';

let home: string;
let dead: boolean;
let calls: string[][];
const window: WindowRef = { tmuxPane: '%7', tmuxSocket: '/tmp/tmux-501/lobstah' };
const screen = Array.from({ length: 230 }, (_, index) => `terminal line ${index}`).join('\n') + '\n\n';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pane-reap-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  dead = true;
  calls = [];
  terminal.run.mockReset().mockImplementation((args) => {
    // Every production call is confined to the dedicated server.
    expect(args.slice(0, 2)).toEqual(['-L', 'lobstah']);
    const command = args.slice(2);
    calls.push(command);
    if (command[0] === 'list-panes') return `%7|${dead ? 1 : 0}\n`;
    if (command[0] === 'capture-pane') return screen;
    if (command[0] === 'if-shell') {
      // The archive must exist before any close can execute.
      expect(fs.readdirSync(path.join(home, 'logs', 'traps'))).not.toHaveLength(0);
    }
    return '';
  });
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function trap(name = 'worker', win = window): string {
  const worktree = path.join(home, name);
  fs.mkdirSync(worktree, { recursive: true });
  const result = signOnTrap({ worktree, cwd: worktree, harness: 'claude', sessionId: name, window: win, ttlMs: 1000 });
  if (!('ok' in result)) throw new Error('trap unexpectedly held');
  return result.ok.trapId;
}

const closes = (): string[][] => calls.filter((args) => args[0] === 'if-shell');

describe('departing trap panes', () => {
  it.each(['stow', 'ghost'] as const)('%s archives the last 200 lines in the trap log before reaping', (departure) => {
    const id = trap();
    if (departure === 'stow') stowTrap(id);
    else {
      heartbeatTrap(id, { parked: true });
      expect(sweepGhostTraps(1000, Date.now() + 60_000)).toMatchObject([{ trapId: id }]);
    }
    expect(readTrap(id)).toBeUndefined();
    expect(calls.map((args) => args[0])).toEqual(['list-panes', 'capture-pane', 'if-shell']);
    expect(calls[1]).toEqual(['capture-pane', '-p', '-t', '%7', '-S', '-200']);
    expect(closes()).toEqual([['if-shell', '-F', '-t', '%7', '#{pane_dead}', 'kill-pane -t %7', 'display-message -p pane-running']]);
    const log = fs.readFileSync(trapPaneLog(id), 'utf8');
    expect(log).toContain('tmux %7');
    expect(log).toContain('terminal line 30\n');
    expect(log).toContain('terminal line 229\n');
    expect(log).not.toContain('terminal line 29\n');
    expect(log.split('\n').filter((line) => line.startsWith('terminal line'))).toHaveLength(200);
  });

  it('defers a live shell until a later daemon tick observes its exit', () => {
    dead = false;
    const id = trap();
    stowTrap(id);
    expect(closes()).toEqual([]);
    expect(fs.existsSync(trapPaneLog(id))).toBe(false);
    dead = true;
    expect(reapDeadTrapPanes()).toEqual(['%7']);
    expect(fs.readFileSync(trapPaneLog(id), 'utf8')).toContain('terminal line 229');
    calls = [];
    expect(reapDeadTrapPanes()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('retains ownership of an old pane after a re-throw replaces the roster window', () => {
    dead = false;
    const id = trap();
    stowTrap(id);
    trap('worker', { ...window, tmuxPane: '%8' });
    dead = true;
    expect(reapDeadTrapPanes()).toEqual(['%7']);
    expect(fs.readFileSync(trapPaneLog(id), 'utf8')).toContain('tmux %7');
    expect(readTrap(id)?.window?.tmuxPane).toBe('%8');
  });

  it('does not operate on another tmux server or an unverified legacy socket', () => {
    stowTrap(trap('foreign', { ...window, tmuxSocket: '/tmp/tmux-501/default' }));
    stowTrap(trap('legacy', { tmuxPane: '%7' }));
    expect(calls).toEqual([]);
  });
});

describe('dead pane sweep', () => {
  it('keeps running panes and panes owned by live registrations, even if tmux reports them dead', () => {
    const id = trap();
    expect(reapDeadTrapPanes(true)).toEqual([]);
    stowTrap(id);
    calls = [];
    dead = false;
    expect(reapDeadTrapPanes(true)).toEqual([]);
    expect(closes()).toEqual([]);
  });

  it('archives unowned dead panes from older launches on the orphan pass', () => {
    expect(reapDeadTrapPanes()).toEqual([]);
    expect(calls).toEqual([]);
    expect(reapDeadTrapPanes(true)).toEqual(['%7']);
    expect(fs.readFileSync(trapPaneLog('pane-7'), 'utf8')).toContain('terminal line 229');
  });

  it('archives a failed launch under its trap id before it ever signs on', () => {
    rememberTrapPane('failed-launch', window);
    expect(reapDeadTrapPanes(true)).toEqual(['%7']);
    expect(fs.readFileSync(trapPaneLog('failed-launch'), 'utf8')).toContain('terminal line 229');
  });

  it('recovers the trap log destination from the roster for panes created before ownership tracking', () => {
    dead = false;
    const id = trap();
    stowTrap(id);
    fs.rmSync(path.join(home, 'tmux-panes'), { recursive: true });
    dead = true;
    expect(reapDeadTrapPanes(true)).toEqual(['%7']);
    expect(fs.readFileSync(trapPaneLog(id), 'utf8')).toContain('terminal line 229');
    expect(fs.existsSync(trapPaneLog('pane-7'))).toBe(false);
  });

  it.each(['capture', 'log'] as const)('keeps the pane when its %s cannot be saved and retries later', (failure) => {
    rememberTrapPane('failed-save', window, true);
    if (failure === 'log') fs.writeFileSync(path.join(home, 'logs'), 'not a directory');
    else terminal.run.mockImplementationOnce(() => '%7|1\n').mockImplementationOnce(() => { throw new Error('capture failed'); });
    expect(reapDeadTrapPanes()).toEqual([]);
    expect(closes()).toEqual([]);
    if (failure === 'log') fs.rmSync(path.join(home, 'logs'));
    expect(reapDeadTrapPanes()).toEqual(['%7']);
  });

  it('defers while another launch owns the placement lock', () => {
    rememberTrapPane('waiting-launch', window, true);
    fs.mkdirSync(path.join(home, 'tmux-placement.lock'));
    expect(reapDeadTrapPanes(true)).toEqual([]);
    expect(calls).toEqual([]);
    fs.rmdirSync(path.join(home, 'tmux-placement.lock'));
    expect(reapDeadTrapPanes()).toEqual(['%7']);
  });

  it('keeps a pane respawned between listing and closing, with its pending ownership intact', () => {
    rememberTrapPane('respawned', window, true);
    terminal.run.mockImplementationOnce(() => '%7|1\n').mockImplementationOnce(() => screen)
      .mockImplementationOnce(() => 'pane-running\n');
    expect(reapDeadTrapPanes()).toEqual([]);
    expect(reapDeadTrapPanes()).toEqual(['%7']);
  });
});
