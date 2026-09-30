/** Links a live harness session can report for opening that exact session. */
export function validSessionLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return (
    /^claude:\/\/claude\.ai\/[A-Za-z0-9_/-]+$/.test(value) ||
    /^vscode:\/\/anthropic\.claude-code\/open\?session=[A-Za-z0-9_-]+$/.test(value) ||
    /^codex:\/\/threads\/[A-Za-z0-9-]+$/.test(value)
  );
}

/** What a session link's surface needs to know about the session's window. */
export interface LinkWindow {
  bundleId?: string;
  termProgram?: string;
  /** Claude Code's `CLAUDE_CODE_ENTRYPOINT`: `cli`, `claude-vscode`, `claude-desktop`, … */
  entrypoint?: string;
}

const VSCODE_BUNDLE_RE = /(?:VSCode|Cursor|windsurf)/;
const CLAUDE_DESKTOP_BUNDLE = 'com.anthropic.claudefordesktop';
const CODEX_BUNDLE = 'com.openai.codex';

/**
 * Why a session link does not fit the session's window, or undefined when it
 * fits. A link opens an app session: a `vscode://` link the Claude Code VS
 * Code extension, a `claude://` link the Claude desktop app's Code tab, a
 * `codex://` link the Codex app. A CLI session in a terminal (including the
 * Claude desktop app's terminal panel) has none of these. Claude Code's
 * entrypoint decides when it is known (`claude-vscode` is the VS Code
 * extension, `cli` a terminal); a registration without one is judged by its
 * app and terminal. With no window, nothing contradicts the link.
 */
export function linkMismatch(link: string, win: LinkWindow | undefined): string | undefined {
  if (!win) return undefined;
  const ep = win.entrypoint;
  const bundle = win.bundleId;
  if (link.startsWith('vscode://')) {
    if (ep !== undefined) return ep === 'claude-vscode' ? undefined : `a vscode:// link needs the VS Code extension; this session's entrypoint is ${ep}`;
    return bundle === undefined || VSCODE_BUNDLE_RE.test(bundle) ? undefined : `a vscode:// link needs the VS Code extension; this session runs in ${bundle}`;
  }
  if (link.startsWith('claude://')) {
    if (ep !== undefined) {
      return ep === 'cli' || ep === 'claude-vscode' || ep.startsWith('sdk-') ? `a claude:// link needs the Claude desktop app's Code tab; this session's entrypoint is ${ep}` : undefined;
    }
    if (bundle !== undefined && bundle !== CLAUDE_DESKTOP_BUNDLE) return `a claude:// link needs the Claude desktop app; this session runs in ${bundle}`;
    return win.termProgram === 'claude-desktop' ? "a claude:// link needs the Code tab; this session runs in the Claude desktop app's terminal" : undefined;
  }
  if (link.startsWith('codex://')) {
    return bundle === undefined || bundle === CODEX_BUNDLE ? undefined : `a codex:// link needs the Codex app; this session runs in ${bundle}`;
  }
  return undefined;
}
