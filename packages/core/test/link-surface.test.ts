import { describe, expect, it } from 'vitest';
import { linkMismatch } from '../src/index.js';

const VSCODE = 'vscode://anthropic.claude-code/open?session=8c32730c-aaaa-4bbb-8ccc-000000000001';
const DESKTOP = 'claude://claude.ai/claude-code-desktop/local_1';
const CODEX = 'codex://threads/019a0000-0000-7000-8000-000000000001';

describe('a session link fits its surface', () => {
  it('a vscode:// link fits only the VS Code extension', () => {
    expect(linkMismatch(VSCODE, { entrypoint: 'claude-vscode', bundleId: 'com.microsoft.VSCode' })).toBeUndefined();
    // The trap that prompted this: a CLI in the Claude desktop app's terminal panel.
    expect(linkMismatch(VSCODE, { entrypoint: 'cli', bundleId: 'com.anthropic.claudefordesktop', termProgram: 'claude-desktop' })).toMatch(/needs the VS Code extension; this session's entrypoint is cli/);
    // A CLI in VS Code's own terminal is still a CLI.
    expect(linkMismatch(VSCODE, { entrypoint: 'cli', bundleId: 'com.microsoft.VSCode', termProgram: 'vscode' })).toBeDefined();
    // An older registration without an entrypoint is judged by its app.
    expect(linkMismatch(VSCODE, { bundleId: 'com.anthropic.claudefordesktop', termProgram: 'claude-desktop' })).toMatch(/runs in com\.anthropic\.claudefordesktop/);
    expect(linkMismatch(VSCODE, { bundleId: 'com.todesktop.230313mzl4w4u92' })).toBeDefined();
    expect(linkMismatch(VSCODE, { bundleId: 'com.microsoft.VSCode' })).toBeUndefined();
  });

  it("a claude:// link fits the Claude desktop app's Code tab, never a terminal", () => {
    expect(linkMismatch(DESKTOP, { entrypoint: 'claude-desktop', bundleId: 'com.anthropic.claudefordesktop' })).toBeUndefined();
    expect(linkMismatch(DESKTOP, { entrypoint: 'cli', bundleId: 'com.anthropic.claudefordesktop', termProgram: 'claude-desktop' })).toBeDefined();
    expect(linkMismatch(DESKTOP, { bundleId: 'com.anthropic.claudefordesktop', termProgram: 'claude-desktop' })).toMatch(/terminal/);
    expect(linkMismatch(DESKTOP, { bundleId: 'com.anthropic.claudefordesktop' })).toBeUndefined();
    expect(linkMismatch(DESKTOP, { bundleId: 'com.googlecode.iterm2', termProgram: 'iTerm.app' })).toBeDefined();
  });

  it('a codex:// link fits the Codex app, not a terminal app', () => {
    expect(linkMismatch(CODEX, { bundleId: 'com.openai.codex' })).toBeUndefined();
    expect(linkMismatch(CODEX, { bundleId: 'com.googlecode.iterm2', termProgram: 'iTerm.app' })).toMatch(/needs the Codex app/);
  });

  it('with no window, nothing contradicts a link', () => {
    for (const link of [VSCODE, DESKTOP, CODEX]) expect(linkMismatch(link, undefined)).toBeUndefined();
    expect(linkMismatch(VSCODE, {})).toBeUndefined();
  });
});
