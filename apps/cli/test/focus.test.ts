import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, writeTrapAnchor } from '@lobstah/core';
import type { TrapRegistration, WindowRef } from '@lobstah/core';
import { focusRegistration, focusTrap, tmuxAttachCommand } from '../src/focus.js';
import type { FileReader, FileRunner } from '../src/focus.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let worktree: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-focus-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  writeTrapAnchor(worktree, { trapId: 'deadbeef' });
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const reg = (window?: WindowRef, link?: string): TrapRegistration => ({
  trapId: 'deadbeef', worktree, cwd: worktree, harness: 'claude', sessionId: 'session-one',
  signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), window, link,
});
const calls = () => {
  const seen: Array<[string, string[]]> = [];
  const run: FileRunner = async (file, args) => { seen.push([file, args]); };
  return { seen, run };
};
const ITERM = 'w0t2p0:11111111-2222-3333-4444-555555555555';

describe('safe window focus ladder', () => {
  it("selects and zooms a tmux trap's pane on its own server, then raises the Terminal window attached to it", async () => {
    const { seen, run } = calls();
    const read: FileReader = async () => '/dev/ttys021\n';
    const win = { termProgram: 'tmux', tmuxPane: '%0', tmuxSocket: '/private/tmp/tmux-501/lobstah', bundleId: 'com.apple.Terminal' };
    expect(await focusRegistration(reg(win), { platform: 'darwin', run, read })).toMatchObject({ focused: true, step: 'tmux' });
    expect(seen[0]).toEqual(['tmux', ['-S', '/private/tmp/tmux-501/lobstah', 'select-window', '-t', '%0', ';', 'select-pane', '-t', '%0', ';',
      'if-shell', '-F', '-t', '%0', '#{window_zoomed_flag}', '', 'resize-pane -Z -t %0']]);
    expect(seen[1]?.[0]).toBe('osascript');
    expect(seen[1]?.[1].slice(-2)).toEqual(['--', 'ttys021']);
  });

  it('says how to attach when no Terminal window shows the pane, and never opens the bundle that started the server', async () => {
    const { seen, run } = calls();
    const read: FileReader = async () => '';
    const result = await focusRegistration(reg({ termProgram: 'tmux', tmuxPane: '%3', bundleId: 'com.apple.Terminal' }), { platform: 'darwin', run, read, machine: 'studio' });
    expect(result).toEqual({ focused: false, reason: "Selected the trap's tmux pane on studio, but no Terminal window shows it — run `tmux -L lobstah attach -t %3`" });
    expect(seen.map(([file]) => file)).toEqual(['tmux']);
    expect(await focusRegistration(reg({ tmuxPane: '%3', tmuxSocket: 'relative/socket' }), { platform: 'darwin', run, read })).toEqual({ focused: false, reason: 'Invalid recorded tmux socket' });
  });

  it('names the machine in every successful result', async () => {
    const { run } = calls();
    const windows: WindowRef[] = [
      { termProgram: 'Apple_Terminal', tty: 'ttys001' },
      { bundleId: 'com.apple.Safari' },
    ];
    for (const win of windows) {
      const result = await focusRegistration(reg(win), { platform: 'darwin', run, read: async () => '', machine: 'studio' });
      expect(result).toMatchObject({ focused: true, message: expect.stringContaining('on studio') });
    }
    const linked = await focusRegistration(reg(undefined, 'codex://threads/abc'), { platform: 'darwin', run, machine: 'studio' });
    expect(linked).toMatchObject({ focused: true, message: 'Opened the session link on studio' });
  });

  it('writes the attach command for where it will be pasted', () => {
    const here = { onMachine: true, machine: 'studio' };
    const away = { onMachine: false, machine: 'studio' };
    expect(tmuxAttachCommand({ tmuxPane: '%12' }, here)).toBe('tmux -L lobstah attach -t %12');
    expect(tmuxAttachCommand({ tmuxPane: '%12' }, away)).toBe('ssh studio -t tmux -L lobstah attach -r -t %12');
    expect(tmuxAttachCommand({ tmuxPane: '%12', tmuxSocket: '/private/tmp/tmux-501/lobstah' }, away)).toBe('ssh studio -t tmux -S /private/tmp/tmux-501/lobstah attach -r -t %12');
  });

  it('offers no attach command for a value it could not paste unquoted', () => {
    const here = { onMachine: true, machine: 'studio' };
    expect(tmuxAttachCommand(undefined, here)).toBeUndefined();
    expect(tmuxAttachCommand({ termProgram: 'Apple_Terminal' }, here)).toBeUndefined();
    expect(tmuxAttachCommand({ tmuxPane: '%1; rm -rf ~' }, here)).toBeUndefined();
    expect(tmuxAttachCommand({ tmuxPane: '%1', tmuxSocket: '/tmp/a b' }, here)).toBeUndefined();
    expect(tmuxAttachCommand({ tmuxPane: '%1', tmuxSocket: '/tmp/$(id)' }, here)).toBeUndefined();
    expect(tmuxAttachCommand({ tmuxPane: '%1' }, { onMachine: false, machine: '-oProxyCommand=id' })).toBeUndefined();
  });

  describe('a tmux pane with nothing showing it', () => {
    const pane = reg({ termProgram: 'tmux', tmuxPane: '%3' });
    const glass = { platform: 'darwin' as const, machine: 'studio', openTerminal: true };

    it('opens one Terminal window attached to the pane when the glass asks', async () => {
      const { seen, run } = calls();
      const result = await focusRegistration(pane, { ...glass, run, read: async () => '' });
      expect(result).toEqual({ focused: true, step: 'tmux', message: 'Opened a Terminal window on studio' });
      expect(seen.map(([file]) => file)).toEqual(['tmux', 'osascript']);
      expect(seen[1]?.[1].slice(-2)).toEqual(['--', 'tmux -L lobstah attach -t %3']);
    });

    it('prints the command and opens nothing from the CLI', async () => {
      const { seen, run } = calls();
      const result = await focusRegistration(pane, { platform: 'darwin', machine: 'studio', run, read: async () => '' });
      expect(result).toMatchObject({ focused: false, reason: expect.stringContaining('tmux -L lobstah attach -t %3') });
      expect(seen.map(([file]) => file)).toEqual(['tmux']);
    });

    it('opens no second window when a client is attached in another app', async () => {
      const { seen, run } = calls();
      const notTerminal: FileRunner = async (file, args) => {
        await run(file, args);
        if (file === 'osascript') throw new Error('tab not found');
      };
      const result = await focusRegistration(pane, { ...glass, run: notTerminal, read: async () => '/dev/ttys021\n' });
      expect(result).toEqual({ focused: true, step: 'tmux', message: "Selected the pane on studio, it's open in another app" });
      expect(seen.filter(([file]) => file === 'osascript')).toHaveLength(1);
    });

    it('opens nothing when tmux cannot list its clients', async () => {
      const { seen, run } = calls();
      const result = await focusRegistration(pane, { ...glass, run, read: async () => { throw new Error('no server'); } });
      expect(result).toMatchObject({ focused: false });
      expect(seen.map(([file]) => file)).toEqual(['tmux']);
    });

    it('falls back to the command when Terminal refuses', async () => {
      const refused: FileRunner = async (file) => { if (file === 'osascript') throw new Error('not allowed'); };
      const result = await focusRegistration(pane, { ...glass, run: refused, read: async () => '' });
      expect(result).toMatchObject({ focused: false, reason: expect.stringContaining('attach -t %3') });
    });

    it('opens no window for a recorded value that fails validation or needs quoting', async () => {
      for (const window of [{ tmuxPane: '%3;id' }, { tmuxPane: '%3', tmuxSocket: 'relative/socket' }, { tmuxPane: '%3', tmuxSocket: '/tmp/a b' }]) {
        const { seen, run } = calls();
        const result = await focusRegistration(reg(window), { ...glass, run, read: async () => '' });
        expect(result).toMatchObject({ focused: false });
        expect(seen.filter(([file]) => file === 'osascript')).toHaveLength(0);
      }
    });
  });

  it('opens a validated session link before any native window step', async () => {
    const { seen, run } = calls();
    const result = await focusRegistration(reg({ itermSession: ITERM }, 'codex://threads/a-b'), { platform: 'darwin', run });
    expect(result).toMatchObject({ focused: true, step: 'link' });
    expect(seen).toEqual([['open', ['codex://threads/a-b']]]);
  });

  it('uses the platform URL opener for Linux and Windows, but no native window focus', async () => {
    const linux = calls();
    expect(await focusRegistration(reg(undefined, 'claude://claude.ai/local_1'), { platform: 'linux', run: linux.run })).toMatchObject({ step: 'link' });
    expect(linux.seen).toEqual([['xdg-open', ['claude://claude.ai/local_1']]]);
    const windows = calls();
    expect(await focusRegistration(reg(undefined, 'vscode://anthropic.claude-code/open?session=x'), { platform: 'win32', run: windows.run })).toMatchObject({ step: 'link' });
    expect(windows.seen).toEqual([['rundll32', ['url.dll,FileProtocolHandler', 'vscode://anthropic.claude-code/open?session=x']]]);
    const noLink = calls();
    expect(await focusRegistration(reg({ itermSession: ITERM }), { platform: 'linux', run: noLink.run })).toMatchObject({ focused: false, reason: expect.stringContaining('not supported') });
    expect(noLink.seen).toEqual([]);
  });

  it('passes an exact iTerm id as an osascript argument, never in script text', async () => {
    const { seen, run } = calls();
    expect(await focusRegistration(reg({ itermSession: ITERM }), { platform: 'darwin', run })).toMatchObject({ step: 'iterm' });
    expect(seen[0]?.[0]).toBe('osascript');
    expect(seen[0]?.[1].slice(-2)).toEqual(['--', ITERM.split(':')[1]]);
    expect(seen[0]?.[1][1]).toContain('on run argv');
    expect(seen[0]?.[1][1]).not.toContain(ITERM.split(':')[1]);
  });

  it('selects a Terminal tty by argument, then can fall through to it after an iTerm failure', async () => {
    const seen: Array<[string, string[]]> = [];
    const run: FileRunner = async (file, args) => {
      seen.push([file, args]);
      if (seen.length === 1) throw new Error('session absent');
    };
    const result = await focusRegistration(reg({ itermSession: ITERM, termProgram: 'Apple_Terminal', tty: 'ttys003' }), { platform: 'darwin', run });
    expect(result).toMatchObject({ step: 'terminal' });
    expect(seen.map((x) => x[1].at(-1))).toEqual([ITERM.split(':')[1], 'ttys003']);
    expect(seen[1]?.[1][1]).not.toContain('ttys003');
  });

  it('opens only the anchored worktree in a VS Code family app', async () => {
    const { seen, run } = calls();
    expect(await focusRegistration(reg({ bundleId: 'com.microsoft.VSCode' }), { platform: 'darwin', run })).toMatchObject({ step: 'vscode' });
    expect(seen).toEqual([['open', ['-b', 'com.microsoft.VSCode', worktree]]]);
  });

  it('reports an app-only activation as inexact', async () => {
    const { seen, run } = calls();
    expect(await focusRegistration(reg({ bundleId: 'com.apple.Safari' }), { platform: 'darwin', run })).toMatchObject({
      step: 'app', message: expect.stringContaining('exact window is not known'),
    });
    expect(seen).toEqual([['open', ['-b', 'com.apple.Safari']]]);
  });

  it('refuses malformed registration fields before executing any command', async () => {
    const bad: WindowRef[] = [
      { itermSession: `${ITERM}'` }, { tty: 'ttys003; open x' }, { tty: 'tty s003' },
      { bundleId: 'com.apple/Safari' }, { bundleId: 'com.apple.Safari\n' }, { tmuxPane: '%1;id' },
      { kittyWindow: '1\n2' }, { weztermPane: '2/3' },
    ];
    for (const win of bad) {
      const { seen, run } = calls();
      expect(await focusRegistration(reg(win), { platform: 'darwin', run })).toMatchObject({ focused: false });
      expect(seen).toEqual([]);
    }
    const { seen, run } = calls();
    const mismatch = { ...reg({ bundleId: 'com.microsoft.VSCode' }), worktree: path.join(home, 'not-this-trap') };
    expect(await focusRegistration(mismatch, { platform: 'darwin', run })).toMatchObject({ focused: false });
    expect(seen).toEqual([]);
  });

  it('rejects an invalid stored link at read time, and never focuses a trap that is not live', async () => {
    const { seen, run } = calls();
    expect(await focusRegistration(reg(undefined, 'javascript:alert(1)'), { platform: 'linux', run })).toMatchObject({ focused: false });
    expect(await focusTrap('deadbeef', { platform: 'darwin', run })).toMatchObject({ focused: false, reason: 'Trap is not live' });
    expect(seen).toEqual([]);
  });
});
