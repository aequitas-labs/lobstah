import { describe, expect, it } from 'vitest';
import { ITERM_TITLE_SCRIPT, TERMINAL_TITLE_SCRIPT, setTerminalTitle, titleCommand } from '../src/terminal-title.js';

const env = {}; // the suite sets LOBSTAH_TERMINAL_TITLE=0; these calls use a fake runner
const terminal = { termProgram: 'Apple_Terminal', tty: 'ttys007' };
const iterm = { termProgram: 'iTerm.app', tty: 'ttys012', itermSession: 'w0t0p0:ABC' };

describe('terminal tab titles', () => {
  it('names a Terminal.app tab by tty, passing tty and name as argv', () => {
    expect(titleCommand(terminal, 'amber-gull', 'darwin')).toEqual({
      target: 'terminal',
      file: 'osascript',
      args: ['-e', TERMINAL_TITLE_SCRIPT, '--', 'ttys007', 'amber-gull'],
    });
    expect(TERMINAL_TITLE_SCRIPT).toContain('set custom title of t to newTitle');
    expect(TERMINAL_TITLE_SCRIPT).toContain('set title displays custom title of t to (newTitle is not "")');
    expect(TERMINAL_TITLE_SCRIPT).toContain('if (tty of t as string) is targetTty then');
  });

  it('names an iTerm2 session by tty', () => {
    expect(titleCommand(iterm, 'amber-gull', 'darwin')).toEqual({
      target: 'iterm',
      file: 'osascript',
      args: ['-e', ITERM_TITLE_SCRIPT, '--', 'ttys012', 'amber-gull'],
    });
    expect(ITERM_TITLE_SCRIPT).toContain('set name of s to newTitle');
    expect(ITERM_TITLE_SCRIPT).toContain('if (tty of s as string) is targetTty then');
  });

  it('clears with an empty title', () => {
    expect(titleCommand(terminal, '', 'darwin')?.args.at(-1)).toBe('');
  });

  it('does nothing off macOS, for other terminals, a bad tty, or a title that is not a trap name', () => {
    expect(titleCommand(terminal, 'amber-gull', 'linux')).toBeUndefined();
    expect(titleCommand({ termProgram: 'vscode', tty: 'ttys007' }, 'amber-gull', 'darwin')).toBeUndefined();
    expect(titleCommand({ termProgram: 'Apple_Terminal' }, 'amber-gull', 'darwin')).toBeUndefined();
    expect(titleCommand({ termProgram: 'Apple_Terminal', tty: '../ttys007' }, 'amber-gull', 'darwin')).toBeUndefined();
    expect(titleCommand(terminal, 'x" & do shell script "id', 'darwin')).toBeUndefined();
    expect(titleCommand(undefined, 'amber-gull', 'darwin')).toBeUndefined();
  });

  it('runs the command, and reports a failure without throwing', async () => {
    const calls: Array<[string, string[]]> = [];
    const ok = await setTerminalTitle(terminal, 'amber-gull', { platform: 'darwin', env, run: async (f, a) => void calls.push([f, a]) });
    expect(ok).toEqual({ named: true, target: 'terminal' });
    expect(calls).toHaveLength(1);
    const failed = await setTerminalTitle(terminal, 'amber-gull', {
      platform: 'darwin',
      env,
      run: async () => {
        throw Object.assign(new Error('boom'), { stderr: 'execution error: tab not found (-2700)' });
      },
    });
    expect(failed).toEqual({ named: false, reason: 'osascript failed: execution error: tab not found (-2700)' });
    const skipped = await setTerminalTitle(terminal, 'amber-gull', { platform: 'linux', env, run: async () => void calls.push(['x', []]) });
    expect(skipped.named).toBe(false);
    const off = await setTerminalTitle(terminal, 'amber-gull', { platform: 'darwin', env: { LOBSTAH_TERMINAL_TITLE: '0' }, run: async () => void calls.push(['x', []]) });
    expect(off).toEqual({ named: false, reason: 'LOBSTAH_TERMINAL_TITLE=0' });
    expect(calls).toHaveLength(1);
  });
});
