import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { wharfSessionPid } from '../src/wharf-session-pid.js';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); delete process.env.LOBSTAH_WHARF_SESSION_PID; });
it('uses the fixed launch wrapper lifetime instead of a tool shell or terminal application', () => {
  process.env.LOBSTAH_WHARF_SESSION_PID = '321';
  expect(wharfSessionPid()).toBe(321); expect(execFileSync).not.toHaveBeenCalled();
});
it('checks only exact invocation ancestors and recognizes the manual harness process', () => {
  vi.spyOn(process, 'ppid', 'get').mockReturnValue(100);
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (process.platform === 'win32') {
      expect(String(args?.at(-1))).toMatch(/ProcessId=(100|200)/);
      return String(args?.at(-1)).includes('ProcessId=100') ? '{"ParentProcessId":200,"Name":"shell.exe"}' : '{"ParentProcessId":1,"Name":"codex.exe"}';
    }
    expect(args).toEqual(['-o', 'ppid=,comm=', '-p', expect.stringMatching(/^(100|200)$/)]);
    return args?.at(-1) === '100' ? '200 /bin/sh' : '1 /path/codex';
  });
  expect(wharfSessionPid()).toBe(200); expect(execFileSync).toHaveBeenCalledTimes(2);
});
it('refuses an unknown or vanished ancestor instead of renewing against a short-lived tool PID', () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('gone'); });
  expect(() => wharfSessionPid()).toThrow('cannot identify the live harness process');
});
