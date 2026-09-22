import { execFileSync } from 'node:child_process';

/**
 * Where a session's window lives, captured at sign-on from the environment
 * the terminal stamped into it — enough for a native companion to focus the
 * exact pane, tab, or window later. Capture is pure reads (env plus one ps
 * walk); acting on it is the reader's business.
 */
export interface WindowRef {
  /** Hosting app, e.g. com.googlecode.iterm2, com.microsoft.VSCode. */
  bundleId?: string;
  termProgram?: string;
  /** Controlling tty of the nearest terminal-attached ancestor. */
  tty?: string;
  /** iTerm2 window/tab/pane id (w0t2p0:UUID). */
  itermSession?: string;
  /** tmux pane — survives detach and reattach anywhere. */
  tmuxPane?: string;
  kittyWindow?: string;
  weztermPane?: string;
}

function ancestorTty(): string | undefined {
  try {
    let pid = process.ppid;
    for (let hop = 0; hop < 15 && pid > 1; hop++) {
      const out = execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (!out) return undefined;
      const [ppid, tty] = out.split(/\s+/);
      if (tty && tty !== '??' && tty !== '?' && tty !== '-') return tty;
      pid = Number(ppid);
      if (!Number.isFinite(pid)) return undefined;
    }
  } catch {
    // no ps (or an odd tree) — the env fields still stand on their own
  }
  return undefined;
}

export function captureWindow(env: NodeJS.ProcessEnv = process.env): WindowRef | undefined {
  const ref: WindowRef = {
    bundleId: env.__CFBundleIdentifier,
    termProgram: env.TERM_PROGRAM,
    itermSession: env.ITERM_SESSION_ID,
    tmuxPane: env.TMUX_PANE,
    kittyWindow: env.KITTY_WINDOW_ID,
    weztermPane: env.WEZTERM_PANE,
    tty: ancestorTty(),
  };
  for (const k of Object.keys(ref) as Array<keyof WindowRef>) {
    if (ref[k] === undefined) delete ref[k];
  }
  return Object.keys(ref).length > 0 ? ref : undefined;
}
