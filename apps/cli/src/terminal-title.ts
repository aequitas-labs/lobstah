import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { TRAP_NAME_RE, trapDisplayName } from '@lobstah/core';
import type { WindowRef } from '@lobstah/core';
import { TMUX_SOCKET } from './tmux-terminal.js';

const exec = promisify(execFile);
export type ScriptRunner = (file: string, args: string[]) => Promise<void>;

const runFile: ScriptRunner = async (file, args) => {
  await exec(file, args, { timeout: 5000, maxBuffer: 64 * 1024 });
};

/**
 * Terminal.app: the tab whose tty matches gets the custom title, shown in
 * place of the default title. An empty title clears it. The tty and title
 * arrive as argv, never as script text.
 */
export const TERMINAL_TITLE_SCRIPT = `on run argv
  set targetTty to "/dev/" & item 1 of argv
  set newTitle to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t as string) is targetTty then
          set custom title of t to newTitle
          set title displays custom title of t to (newTitle is not "")
          return "named"
        end if
      end repeat
    end repeat
  end tell
  error "tab not found"
end run`;

/** iTerm2: the session whose tty matches gets the name. An empty name clears it. */
export const ITERM_TITLE_SCRIPT = `on run argv
  set targetTty to "/dev/" & item 1 of argv
  set newTitle to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s as string) is targetTty then
            set name of s to newTitle
            return "named"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found"
end run`;

const TTY_RE = /^ttys[0-9]{3,5}$/;
const TMUX_PANE_RE = /^%(?:0|[1-9][0-9]*)$/;

export type TitleTarget = 'terminal' | 'iterm' | 'tmux';

/** A repo key plain enough to sit in a tab title. */
const TAB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The tab or pane title a trap may set: its name, after its repo when that is plain. */
const TAB_TITLE_RE = new RegExp(`^(?:${TAB_REPO_RE.source.slice(1, -1)} · )?${TRAP_NAME_RE.source.slice(1, -1)}$`);

/** The title a trap's terminal tab or tmux pane carries: `homebase · fresh-cove`. */
export function trapTabTitle(name: string, repo: string | undefined): string {
  return trapDisplayName({ trapId: name, name, repo: repo && TAB_REPO_RE.test(repo) ? repo : undefined });
}

/** The pane and socket of a window on lobstah's own tmux server. A person's own tmux is never touched. */
function lobstahTmuxPane(win: WindowRef): { pane: string; socket: string } | undefined {
  const { tmuxPane: pane, tmuxSocket: socket } = win;
  if (typeof pane !== 'string' || !TMUX_PANE_RE.test(pane) || typeof socket !== 'string') return undefined;
  return path.posix.isAbsolute(socket) && path.posix.basename(socket) === TMUX_SOCKET ? { pane, socket } : undefined;
}

/**
 * The argv that sets the title of the recorded window: its pane on lobstah's
 * tmux server, or (where an empty title clears it) its Terminal.app or iTerm2
 * tab. A pane keeps its title at stow, since it still shows that trap's
 * session. Undefined for any other window, or when the title is not a trap's
 * (see trapTabTitle). That check also matters to tmux, which expands a title
 * as a format and would run a `#(...)` in it.
 */
export function titleCommand(
  win: WindowRef | undefined,
  title: string,
  platform: NodeJS.Platform = process.platform,
): { target: TitleTarget; file: string; args: string[] } | undefined {
  if (!win || (title !== '' && !TAB_TITLE_RE.test(title))) return undefined;
  const tmux = lobstahTmuxPane(win);
  if (tmux) {
    return title === '' ? undefined : { target: 'tmux', file: 'tmux', args: ['-S', tmux.socket, 'select-pane', '-t', tmux.pane, '-T', title] };
  }
  if (platform !== 'darwin' || typeof win.tty !== 'string' || !TTY_RE.test(win.tty)) return undefined;
  const target: TitleTarget | undefined =
    win.termProgram === 'Apple_Terminal' ? 'terminal' : win.termProgram === 'iTerm.app' ? 'iterm' : undefined;
  if (!target) return undefined;
  const script = target === 'terminal' ? TERMINAL_TITLE_SCRIPT : ITERM_TITLE_SCRIPT;
  return { target, file: 'osascript', args: ['-e', script, '--', win.tty, title] };
}

export type TitleResult = { named: true; target: TitleTarget } | { named: false; reason: string };

/** Name the trap's tmux pane or terminal tab, or clear a tab's name with `''`. `LOBSTAH_TERMINAL_TITLE=0` turns it off. Never throws. */
export async function setTerminalTitle(
  win: WindowRef | undefined,
  title: string,
  options: { platform?: NodeJS.Platform; run?: ScriptRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<TitleResult> {
  if ((options.env ?? process.env).LOBSTAH_TERMINAL_TITLE === '0') return { named: false, reason: 'LOBSTAH_TERMINAL_TITLE=0' };
  const cmd = titleCommand(win, title, options.platform);
  if (!cmd) return { named: false, reason: "not a Terminal.app or iTerm2 tab with a recorded tty, or a pane on lobstah's tmux server" };
  try {
    await (options.run ?? runFile)(cmd.file, cmd.args);
    return { named: true, target: cmd.target };
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
    return { named: false, reason: `${cmd.file} failed: ${detail.split('\n')[0]}` };
  }
}
