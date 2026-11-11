import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { captureWindow } from '../src/window.js';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '1 ??') }));

it('captures Windows app references without invoking POSIX ps', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(captureWindow({ TERM_PROGRAM: 'vscode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })).toEqual({ termProgram: 'vscode', entrypoint: 'claude-vscode' });
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
