import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, readTrap, trapIdAt, trapLastSeen, validSessionLink } from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';

const exec = promisify(execFile);
export type FocusStep = 'link' | 'iterm' | 'terminal' | 'vscode' | 'app';
export type FocusResult = { focused: true; step: FocusStep; message: string } | { focused: false; reason: string };
export type FileRunner = (file: string, args: string[]) => Promise<void>;

const runFile: FileRunner = async (file, args) => {
  await exec(file, args, { timeout: 5000, maxBuffer: 64 * 1024 });
};

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
const ITERM_RE = /^w[0-9]+t[0-9]+p[0-9]+:([A-Fa-f0-9-]{36})$/;
const VSCODE_RE = /(?:VSCode|Cursor|windsurf)/;

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
  options: { platform?: NodeJS.Platform; run?: FileRunner } = {},
): Promise<FocusResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runFile;
  const attempt = async (file: string, args: string[], step: FocusStep, message: string): Promise<FocusResult | undefined> => {
    try {
      await run(file, args);
      return { focused: true, step, message };
    } catch {
      return undefined;
    }
  };
  if (validSessionLink(reg.link)) {
    const opener: [string, string[]] = platform === 'darwin' ? ['open', [reg.link]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', reg.link]] : ['xdg-open', [reg.link]];
    const result = await attempt(opener[0], opener[1], 'link', 'Opened the session link.');
    if (result) return result;
  }
  if (platform !== 'darwin') return { focused: false, reason: 'Window focus is not supported on this platform.' };
  const win = reg.window;
  if (!win) return { focused: false, reason: 'This trap did not record a window.' };

  const iterm = typeof win.itermSession === 'string' ? ITERM_RE.exec(win.itermSession) : null;
  if (iterm) {
    const result = await attempt('osascript', ['-e', ITERM_SCRIPT, '--', iterm[1]!], 'iterm', 'Focused the iTerm2 session.');
    if (result) return result;
  }
  if (win.termProgram === 'Apple_Terminal' && typeof win.tty === 'string' && TTY_RE.test(win.tty)) {
    const result = await attempt('osascript', ['-e', TERMINAL_SCRIPT, '--', win.tty], 'terminal', 'Focused the Terminal tab.');
    if (result) return result;
  }
  // tmux, kitty and WezTerm are intentionally skipped until selecting the
  // recorded pane can be verified on this machine.
  const bundle = typeof win.bundleId === 'string' && BUNDLE_RE.test(win.bundleId) ? win.bundleId : undefined;
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

export async function focusTrap(trapId: string, options: { platform?: NodeJS.Platform; run?: FileRunner } = {}): Promise<FocusResult> {
  const reg = liveTrap(trapId);
  return reg ? focusRegistration(reg, options) : { focused: false, reason: 'Trap is not live.' };
}
