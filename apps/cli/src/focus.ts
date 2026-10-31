import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linkMismatch, loadConfig, readTrap, trapIdAt, trapLastSeen, validSessionLink } from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { TMUX_SOCKET } from './tmux-terminal.js';

const exec = promisify(execFile);
export type FocusStep = 'link' | 'iterm' | 'tmux' | 'terminal' | 'vscode' | 'app';
export type FocusResult = { focused: true; step: FocusStep; message: string } | { focused: false; reason: string };
export type FileRunner = (file: string, args: string[]) => Promise<void>;
/** Runs a command and returns its stdout. */
export type FileReader = (file: string, args: string[]) => Promise<string>;

const runFile: FileRunner = async (file, args) => {
  await exec(file, args, { timeout: 5000, maxBuffer: 64 * 1024 });
};
const readFile: FileReader = async (file, args) => (await exec(file, args, { timeout: 5000, maxBuffer: 64 * 1024 })).stdout;

const ITERM_SCRIPT = `on run argv
  set targetId to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s contains targetId then
            select t
            select w
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found"
end run`;

const TERMINAL_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t as string) ends with targetTty then
          set selected of t to true
          set frontmost of w to true
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  error "tab not found"
end run`;

const BUNDLE_RE = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;
const TTY_RE = /^ttys[0-9]{3,5}$/;
const ITERM_RE = /^w[0-9]+t[0-9]+p[0-9]+:([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})$/;
const TMUX_RE = /^%(0|[1-9][0-9]*)$/;
const SOCKET_RE = /^\/[^\x00-\x1f\x7f]+$/;
const PANE_RE = /^[1-9][0-9]*$/;
const VSCODE_RE = /(?:VSCode|Cursor|windsurf)/;
const control = (value: string): boolean => /[\x00-\x1f\x7f]/.test(value);

function safeWorktree(reg: TrapRegistration): boolean {
  const folder = reg.worktree;
  if (!path.isAbsolute(folder) || /[\x00-\x1f\x7f]/.test(folder) || path.normalize(folder) !== folder) return false;
  try {
    return fs.statSync(folder).isDirectory() && trapIdAt(folder) === reg.trapId;
  } catch {
    return false;
  }
}

/** One common focus ladder for the CLI and the glass. Registration fields are untrusted. */
export async function focusRegistration(
  reg: TrapRegistration,
  options: { platform?: NodeJS.Platform; run?: FileRunner; read?: FileReader } = {},
): Promise<FocusResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runFile;
  const read = options.read ?? readFile;
  const attempt = async (file: string, args: string[], step: FocusStep, message: string): Promise<FocusResult | undefined> => {
    try {
      await run(file, args);
      return { focused: true, step, message };
    } catch {
      return undefined;
    }
  };
  const win = reg.window;
  if (reg.link !== undefined && !validSessionLink(reg.link))
    return { focused: false, reason: 'Invalid recorded session link.' };

  // A registration is writable by local processes. Refuse malformed values
  // before attempting any action, even one that would use a different
  // field later in the ladder.
  if (win?.itermSession !== undefined && (typeof win.itermSession !== 'string' || control(win.itermSession) || !ITERM_RE.test(win.itermSession)))
    return { focused: false, reason: 'Invalid recorded iTerm2 session id.' };
  if (win?.tty !== undefined && (typeof win.tty !== 'string' || control(win.tty) || !TTY_RE.test(win.tty)))
    return { focused: false, reason: 'Invalid recorded tty.' };
  if (win?.bundleId !== undefined && (typeof win.bundleId !== 'string' || control(win.bundleId) || !BUNDLE_RE.test(win.bundleId)))
    return { focused: false, reason: 'Invalid recorded bundle id.' };
  if (win?.tmuxPane !== undefined && (typeof win.tmuxPane !== 'string' || control(win.tmuxPane) || !TMUX_RE.test(win.tmuxPane)))
    return { focused: false, reason: 'Invalid recorded tmux pane.' };
  if (win?.tmuxSocket !== undefined && (typeof win.tmuxSocket !== 'string' || !SOCKET_RE.test(win.tmuxSocket) || path.normalize(win.tmuxSocket) !== win.tmuxSocket))
    return { focused: false, reason: 'Invalid recorded tmux socket.' };
  if (win?.kittyWindow !== undefined && (typeof win.kittyWindow !== 'string' || control(win.kittyWindow) || !PANE_RE.test(win.kittyWindow)))
    return { focused: false, reason: 'Invalid recorded kitty window.' };
  if (win?.weztermPane !== undefined && (typeof win.weztermPane !== 'string' || control(win.weztermPane) || !PANE_RE.test(win.weztermPane)))
    return { focused: false, reason: 'Invalid recorded WezTerm pane.' };
  if (win?.bundleId && VSCODE_RE.test(win.bundleId) && !safeWorktree(reg))
    return { focused: false, reason: 'Recorded editor worktree does not match this trap.' };

  // A link that contradicts the recorded window (a vscode:// link on a
  // terminal session) is skipped: the window ladder below focuses it.
  if (validSessionLink(reg.link) && linkMismatch(reg.link, win) === undefined) {
    const opener: [string, string[]] = platform === 'darwin' ? ['open', [reg.link]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', reg.link]] : ['xdg-open', [reg.link]];
    const result = await attempt(opener[0], opener[1], 'link', 'Opened the session link.');
    if (result) return result;
  }
  if (platform !== 'darwin') return { focused: false, reason: 'Window focus is not supported on this platform.' };
  if (!win) return { focused: false, reason: 'This trap did not record a window.' };

  const iterm = typeof win.itermSession === 'string' ? ITERM_RE.exec(win.itermSession) : null;
  if (iterm) {
    const result = await attempt('osascript', ['-e', ITERM_SCRIPT, '--', iterm[1]!], 'iterm', 'Focused the iTerm2 session.');
    if (result) return result;
  }
  if (typeof win.tmuxPane === 'string') {
    // The pane's own server: the socket recorded at sign-on, else lobstah's.
    const server = win.tmuxSocket ? ['-S', win.tmuxSocket] : ['-L', TMUX_SOCKET];
    const pane = win.tmuxPane;
    const selected = await attempt('tmux', [...server, 'select-window', '-t', pane, ';', 'select-pane', '-t', pane, ';',
      'if-shell', '-F', '-t', pane, '#{window_zoomed_flag}', '', `resize-pane -Z -t ${pane}`], 'tmux', 'Selected the trap\'s tmux pane.');
    if (selected) {
      let clients: string[] = [];
      try {
        clients = (await read('tmux', [...server, 'list-clients', '-t', pane, '-F', '#{client_tty}'])).split('\n').map((t) => t.replace(/^\/dev\//, '')).filter((t) => TTY_RE.test(t));
      } catch {
        // No client attached: nothing to raise.
      }
      for (const tty of clients) {
        const raised = await attempt('osascript', ['-e', TERMINAL_SCRIPT, '--', tty], 'tmux', 'Selected the trap\'s tmux pane and raised its Terminal window.');
        if (raised) return raised;
      }
      const attach = win.tmuxSocket ? `tmux -S ${win.tmuxSocket} attach` : `tmux -L ${TMUX_SOCKET} attach`;
      return { focused: false, reason: `Selected the trap's tmux pane, but no Terminal window shows it — run \`${attach}\`.` };
    }
  }
  if (win.termProgram === 'Apple_Terminal' && typeof win.tty === 'string' && TTY_RE.test(win.tty)) {
    const result = await attempt('osascript', ['-e', TERMINAL_SCRIPT, '--', win.tty], 'terminal', 'Focused the Terminal tab.');
    if (result) return result;
  }
  // kitty and WezTerm are intentionally skipped until selecting the recorded
  // pane can be verified on this machine. A tmux pane's bundle id is the
  // app that started its server, not where the pane shows: never use it.
  const bundle = typeof win.bundleId === 'string' && BUNDLE_RE.test(win.bundleId) && win.termProgram !== 'tmux' ? win.bundleId : undefined;
  if (bundle && VSCODE_RE.test(bundle) && safeWorktree(reg)) {
    const result = await attempt('open', ['-b', bundle, reg.worktree], 'vscode', 'Opened the trap worktree in its editor.');
    if (result) return result;
  }
  if (bundle) {
    const result = await attempt('open', ['-b', bundle], 'app', 'Brought the app forward; the exact window is not known.');
    if (result) return result;
  }
  return { focused: false, reason: 'No recorded window could be focused.' };
}

export function liveTrap(trapId: string): TrapRegistration | undefined {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(trapId)) return undefined;
  const reg = readTrap(trapId);
  if (!reg || reg.trapId !== trapId) return undefined;
  return Date.now() - trapLastSeen(reg) <= loadConfig().soak.ttlSecs * 1000 ? reg : undefined;
}

export async function focusTrap(trapId: string, options: { platform?: NodeJS.Platform; run?: FileRunner; read?: FileReader } = {}): Promise<FocusResult> {
  const reg = liveTrap(trapId);
  return reg ? focusRegistration(reg, options) : { focused: false, reason: 'Trap is not live.' };
}
