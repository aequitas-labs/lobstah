import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { displayGrounds, groundsList, lobstahHome } from '@lobstah/core';
import type { Config } from '@lobstah/core';

const exec = promisify(execFile);

/** lobstah's own tmux server, `tmux -L lobstah`: a person's own tmux is never touched. */
export const TMUX_SOCKET = 'lobstah';
/** The one session every trap window lives in. */
export const TMUX_SESSION = 'lobstah';

/** Runs one tmux command on lobstah's server and returns its stdout. */
export type TmuxRunner = (args: string[]) => Promise<string>;

/** One window of lobstah's session: its name and how many panes it holds. */
export interface TmuxWindow {
  name: string;
  panes: number;
}

/** Where a launched trap landed, for reading its screen later. */
export interface TmuxPaneRef {
  tmuxPane: string;
}

/** lobstah's tmux config, written only when the file is missing so a person's edits stay. */
export const TMUX_CONFIG = `# lobstah's own tmux server (tmux -L lobstah). lobstah writes this file only when it is missing.
set -g mouse on
set -g focus-events on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
set-environment -g COLORTERM truecolor
set -g remain-on-exit failed
set -g automatic-rename off
set -g allow-set-title off
set -g pane-border-status top
set -g pane-border-format " #{pane_title} "
`;

export function tmuxConfigFile(): string {
  return path.join(lobstahHome(), 'tmux.conf');
}

/** Write lobstah's tmux config if it does not exist yet. */
export function ensureTmuxConfig(file = tmuxConfigFile()): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TMUX_CONFIG);
}

/** Variables a new tmux server keeps: where a person's tools and state live. */
const SERVER_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'LOBSTAH_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

/**
 * The environment a server starts with. A throw usually runs inside the
 * helm's own session; its session variables (`CLAUDECODE`, the helm's
 * session id, `TMUX`) must not reach every trap pane, as a new Terminal
 * window's login shell never sees them either.
 */
export function tmuxServerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(SERVER_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** Run tmux on lobstah's server, started with lobstah's config and a clean environment. */
export function tmuxRunner(socket = TMUX_SOCKET): TmuxRunner {
  return async (args) => {
    try {
      const { stdout } = await exec('tmux', ['-L', socket, '-f', tmuxConfigFile(), ...args], { timeout: 10_000, env: tmuxServerEnv() });
      return stdout;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('tmux is not installed — install it (macOS: `brew install tmux`) or set [soak] terminal back to "terminal"');
      }
      throw new Error(`tmux ${args[0]} failed: ${((err as { stderr?: string }).stderr ?? String(err)).trim()}`);
    }
  };
}

/** lobstah's windows, or undefined when its server or session is not running. */
export async function listTmuxWindows(run: TmuxRunner): Promise<TmuxWindow[] | undefined> {
  let out: string;
  try {
    out = await run(['list-windows', '-t', `=${TMUX_SESSION}`, '-F', '#{window_name}\t#{window_panes}']);
  } catch {
    return undefined;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', panes = '0'] = line.split('\t');
      return { name, panes: Number(panes) || 0 };
    });
}

/** A window name tmux targets cleanly: no `.` or `:` (target separators) and no spaces. */
const windowName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '-') || 'traps';

/**
 * The window a trap's pane joins, by `[soak] tmuxPages`: its repo, its
 * grounds (the implicit `home` covers every repo when none are configured),
 * or the first numbered `page-N` window with room for `tmuxPageSize` panes.
 */
export function tmuxWindowFor(cfg: Config, repo: string | undefined, windows: readonly TmuxWindow[]): string {
  if (cfg.soak.tmuxPages === 'fixed') {
    const pages = windows
      .map((w) => ({ ...w, page: /^page-([1-9][0-9]*)$/.exec(w.name)?.[1] }))
      .filter((w): w is TmuxWindow & { page: string } => w.page !== undefined)
      .sort((a, b) => Number(a.page) - Number(b.page));
    const open = pages.find((w) => w.panes < cfg.soak.tmuxPageSize);
    return open ? open.name : `page-${pages.length ? Number(pages.at(-1)!.page) + 1 : 1}`;
  }
  if (cfg.soak.tmuxPages === 'grounds') {
    const grounds = repo === undefined ? undefined : groundsList(cfg).find((g) => g.repos.includes(repo));
    return windowName(grounds ? displayGrounds(grounds.name, cfg) : 'home');
  }
  return windowName(repo ?? 'traps');
}

/**
 * Open a trap's command in a pane of lobstah's tmux session and tile its
 * window. It never takes focus: a person attaches with `tmux -L lobstah
 * attach`, on any Desktop. The command runs in a login shell, as in a new
 * Terminal window, and the pane is titled with the trap's name.
 */
export async function openTmuxPane(
  cfg: Config,
  launch: { cwd: string; command: string; trap?: string; repo?: string },
  run: TmuxRunner = tmuxRunner(),
  shell = process.env.SHELL || '/bin/zsh',
): Promise<TmuxPaneRef> {
  ensureTmuxConfig();
  const windows = await listTmuxWindows(run);
  const window = tmuxWindowFor(cfg, launch.repo, windows ?? []);
  const program = [shell, '-l', '-c', launch.command];
  const placed = ['-c', launch.cwd, '-P', '-F', '#{pane_id}'];
  const out = !windows
    ? await run(['new-session', '-d', '-s', TMUX_SESSION, '-n', window, '-x', '240', '-y', '66', ...placed, ...program])
    : windows.some((w) => w.name === window)
      ? await run(['split-window', '-d', '-t', `=${TMUX_SESSION}:=${window}`, ...placed, ...program])
      : await run(['new-window', '-d', '-t', `=${TMUX_SESSION}:`, '-n', window, ...placed, ...program]);
  const pane = out.trim();
  await run(['select-layout', '-t', `=${TMUX_SESSION}:=${window}`, 'tiled']);
  if (launch.trap) await run(['select-pane', '-t', pane, '-T', launch.trap]);
  return { tmuxPane: pane };
}

/** The last non-blank lines on a pane's screen, or undefined when it cannot be read. */
export async function tmuxPaneTail(pane: string, lines = 6, run: TmuxRunner = tmuxRunner()): Promise<string | undefined> {
  try {
    const screen = (await run(['capture-pane', '-p', '-t', pane])).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    return screen.length ? screen.slice(-lines).join(' ⏎ ') : undefined;
  } catch {
    return undefined;
  }
}
