import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, writeTrapAnchor } from '@lobstah/core';
import type { TrapRegistration, WindowRef } from '@lobstah/core';
import { focusRegistration, focusTrap } from '../src/focus.js';
import type { FileRunner } from '../src/focus.js';

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
  fs.rmSync(home, { recursive: true, force: true });
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
