import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, writeTrapAnchor } from '@lobstah/core';
import type { TrapRegistration, WindowRef } from '@lobstah/core';
import { focusRegistration, focusTrap } from '../src/focus.js';
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
  /** A tmux server's answers: which sessions hold the pane's window, and its clients as `session window activity tty`. */
  const tmuxAnswers = (holders: string[], clients: string[]): FileReader => async (_file, args) => (args.includes('list-panes') ? holders : clients).map((l) => `${l}\n`).join('');
  const SELECT = (target: string, pane: string) => ['select-window', '-t', target, ';', 'select-pane', '-t', pane, ';', 'if-shell', '-F', '-t', pane, '#{window_zoomed_flag}', '', `resize-pane -Z -t ${pane}`];

  it("raises the Terminal window attached to a tmux trap's pane, then selects and zooms it on its own server", async () => {
    const { seen, run } = calls();
    const read = tmuxAnswers(['$0 @1'], ['$0 @2 100 /dev/ttys021']);
    const win = { termProgram: 'tmux', tmuxPane: '%0', tmuxSocket: '/private/tmp/tmux-501/lobstah', bundleId: 'com.apple.Terminal' };
    expect(await focusRegistration(reg(win), { platform: 'darwin', run, read })).toMatchObject({ focused: true, step: 'tmux' });
    expect(seen[0]?.[0]).toBe('osascript');
    expect(seen[0]?.[1].slice(-2)).toEqual(['--', 'ttys021']);
    expect(seen[1]).toEqual(['tmux', ['-S', '/private/tmp/tmux-501/lobstah', ...SELECT('$0:@1', '%0')]]);
  });

  describe('with several views of the trap session', () => {
    const win = { termProgram: 'tmux', tmuxPane: '%4' };
    const HOLDERS = ['$0 @1', '$1 @1', '$2 @1'];

    it('uses the view already showing the window over a more recent one, and moves no other view', async () => {
      const { seen, run } = calls();
      const read = tmuxAnswers(HOLDERS, ['$1 @9 500 /dev/ttys001', '$2 @1 100 /dev/ttys002']);
      expect(await focusRegistration(reg(win), { platform: 'darwin', run, read })).toMatchObject({ focused: true, step: 'tmux' });
      expect(seen.map(([file]) => file)).toEqual(['osascript', 'tmux']);
      expect(seen[0]?.[1].at(-1)).toBe('ttys002');
      expect(seen[1]?.[1].slice(2, 5)).toEqual(['select-window', '-t', '$2:@1']);
    });

    it('otherwise moves the most recently used view, not a session no client is on', async () => {
      const { seen, run } = calls();
      const read = tmuxAnswers(HOLDERS, ['$1 @9 100 /dev/ttys001', '$2 @8 500 /dev/ttys002']);
      await focusRegistration(reg(win), { platform: 'darwin', run, read });
      expect(seen[0]?.[1].at(-1)).toBe('ttys002');
      expect(seen[1]?.[1]).toEqual(['-L', 'lobstah', ...SELECT('$2:@1', '%4')]);
    });

    it('tries the next view when one is not in Terminal, and never counts a client of another session', async () => {
      const seen: string[][] = [];
      const run: FileRunner = async (file, args) => {
        seen.push([file, ...args]);
        if (file === 'osascript' && args.at(-1) === 'ttys002') throw new Error('tab not found');
      };
      const read = tmuxAnswers(HOLDERS, ['$7 @1 900 /dev/ttys007', '$1 @9 100 /dev/ttys001', '$2 @8 500 /dev/ttys002']);
      expect(await focusRegistration(reg(win), { platform: 'darwin', run, read })).toMatchObject({ focused: true, step: 'tmux' });
      expect(seen.filter(([file]) => file === 'osascript').map((c) => c.at(-1))).toEqual(['ttys002', 'ttys001']);
      expect(seen.filter(([file]) => file === 'tmux').map((c) => c[5])).toEqual(['$1:@1']);
    });
  });

  it('says how to attach when no Terminal window shows the pane, and never opens the bundle that started the server', async () => {
    const { seen, run } = calls();
    const read: FileReader = async () => '';
    const result = await focusRegistration(reg({ termProgram: 'tmux', tmuxPane: '%3', bundleId: 'com.apple.Terminal' }), { platform: 'darwin', run, read });
    expect(result).toEqual({ focused: false, reason: "Selected the trap's tmux pane, but no Terminal window shows it — run `tmux -L lobstah attach`." });
    expect(seen.map(([file]) => file)).toEqual(['tmux']);
    expect(await focusRegistration(reg({ tmuxPane: '%3', tmuxSocket: 'relative/socket' }), { platform: 'darwin', run, read })).toEqual({ focused: false, reason: 'Invalid recorded tmux socket.' });
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
    expect(await focusTrap('deadbeef', { platform: 'darwin', run })).toMatchObject({ focused: false, reason: 'Trap is not live.' });
    expect(seen).toEqual([]);
  });
});
