import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { listTraps, shellQuote } from '@lobstah/core';
import type { Config } from '@lobstah/core';
import { tellTerminalApp } from './throw.js';
import { listTmuxWindows, tmuxRunner, tmuxWindowFor, TMUX_SESSION, TMUX_SOCKET } from './tmux-terminal.js';
import type { TmuxRunner, TmuxWindow } from './tmux-terminal.js';

/** How `lobstah tmux` ended: a Terminal window on a new view, or the command to run by hand. */
export type TmuxViewResult = { opened: true; view: string; window: string } | { opened: false; attach: string; reason: string };

/** What opening a view depends on, for tests and a private tmux server. */
export interface TmuxViewOptions {
  socket?: string;
  run?: TmuxRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Opens a new Terminal window running this shell text. */
  openWindow?: (shellText: string) => Promise<void>;
}

/**
 * Terminal opens the window before it comes forward: a new window lands on
 * the current Desktop, so activating it never switches to another Desktop
 * that holds an older Terminal window.
 */
const NEW_WINDOW_SCRIPT = ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell', 'end run'];

/**
 * The tmux command that attaches a new view: a session grouped with lobstah's,
 * sharing its windows with its own current window. The whole line runs at once
 * on the server, so a client is attached before `destroy-unattached` can apply
 * and a missing session stops it before `new-session` could make an empty one.
 * `-N` never starts a server. That option is the view's alone: closing it
 * leaves the windows and their traps in lobstah's session.
 */
export function tmuxViewCommand(view: string, windowId: string, socket: string = TMUX_SOCKET): string[] {
  return [
    'tmux', '-N', '-L', socket,
    'has-session', '-t', `=${TMUX_SESSION}`, ';',
    'new-session', '-t', `=${TMUX_SESSION}`, '-s', view, ';',
    'set-option', '-t', `=${view}:`, 'destroy-unattached', 'on', ';',
    'select-window', '-t', `=${view}:${windowId}`,
  ];
}

/**
 * The window a repo's traps live in. Paging by repo or grounds names it;
 * fixed pages hold any repo's traps, so there it is the first window holding
 * one of this repo's.
 */
async function repoWindow(cfg: Config, repo: string, windows: readonly TmuxWindow[], socket: string, run: TmuxRunner): Promise<TmuxWindow | undefined> {
  if (cfg.soak.tmuxPages !== 'fixed') {
    const name = tmuxWindowFor(cfg, repo, windows);
    return windows.find((w) => w.name === name);
  }
  const panes = new Set(
    listTraps().flatMap((trap) => {
      const win = trap.window;
      const here = !win?.tmuxSocket || path.basename(win.tmuxSocket) === socket;
      return trap.repo === repo && win?.tmuxPane && here ? [win.tmuxPane] : [];
    }),
  );
  const rows = (await run(['list-panes', '-s', '-t', `=${TMUX_SESSION}`, '-F', '#{window_id} #{pane_id}'])).split('\n').map((line) => line.split(' '));
  return windows.find((w) => rows.some(([window, pane]) => window === w.id && panes.has(pane ?? '')));
}

/**
 * Open a new independent view of lobstah's session, starting on a repo's
 * window or else the first. Inside tmux, or off macOS, there is no Terminal
 * window to open from here, so it hands back the command instead. It refuses
 * when there is nothing to show, and never starts a server.
 */
export async function openTmuxView(cfg: Config, repo: string | undefined, options: TmuxViewOptions = {}): Promise<TmuxViewResult> {
  const socket = options.socket ?? TMUX_SOCKET;
  const run = options.run ?? tmuxRunner(socket);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (repo !== undefined && !cfg.repos[repo]) throw new Error(`no repo "${repo}" is configured`);
  const windows = await listTmuxWindows(run);
  if (!windows?.length) throw new Error(`no trap session to show: \`tmux -L ${socket}\` has no "${TMUX_SESSION}" session yet. It starts when a trap is thrown with [soak] terminal = "tmux"`);
  const window = repo === undefined ? windows[0]! : await repoWindow(cfg, repo, windows, socket, run);
  if (!window) throw new Error(`repo "${repo}" has no tmux window. Windows now: ${windows.map((w) => w.name).join(', ')}`);

  const view = `view-${randomBytes(3).toString('hex')}`;
  const command = tmuxViewCommand(view, window.id, socket).map(shellQuote).join(' ');
  if (env.TMUX) return { opened: false, attach: command, reason: 'This is already inside tmux. Run this in a terminal outside it.' };
  if (platform !== 'darwin') return { opened: false, attach: command, reason: 'Opening a Terminal window takes macOS. Run this in a terminal.' };
  // exec: the window's shell becomes the view, so nothing is left running when it detaches.
  const shellText = `exec ${command}`;
  await (options.openWindow ?? ((text: string) => tellTerminalApp('terminal', NEW_WINDOW_SCRIPT, text)))(shellText);
  return { opened: true, view, window: window.name };
}
