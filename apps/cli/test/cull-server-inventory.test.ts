import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execute }));
import { serverRuntime } from '../src/cull-server-inventory.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-server-inventory-'));
  process.env.LOBSTAH_HOME = home; ensureLayout(); execute.mockReset();
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.runIf(process.platform !== 'win32')('discards incomplete process listings while still inspecting containers', () => {
  execute.mockImplementation((command: string, args: string[]) => {
    if (command === 'ps') return '700001 1 700001 Mon Nov 16 12:00:00 2026 node next dev';
    if (command === 'lsof') throw { status: 1, stdout: '', stderr: 'permission denied' };
    if (command === 'docker' && args[0] === 'ps') return 'abc123';
    if (command === 'docker') return JSON.stringify([{ Id: 'abc123', Name: '/db', State: { Running: true, StartedAt: '2026-11-16T12:00:00Z' }, Mounts: [{ Type: 'bind', Source: path.join(home, 'worktrees/app') }] }]);
    return '';
  });
  const result = serverRuntime.inspect();
  expect(result.processes).toEqual([]);
  expect(result.containers[0]?.id).toBe('abc123');
  expect(result.warnings).toContain('Could not inspect listening servers; processes kept.');
  expect(execute.mock.calls.every(([, args]) => !args.includes('stop') && !args.includes('kill-session'))).toBe(true);
});

it.runIf(process.platform !== 'win32')('accepts lsof empty selections without turning inspection into an error', () => {
  execute.mockImplementation((command: string) => {
    if (command === 'ps') return '700001 1 700001 Mon Nov 16 12:00:00 2026 node next dev';
    if (command === 'lsof') throw { status: 1, stdout: '', stderr: '' };
    return '';
  });
  expect(serverRuntime.inspect()).toMatchObject({ processes: [{ pid: 700001, ports: [] }], warnings: [] });
});

it('stops a container by exact id with a grace period and never removes it', () => {
  execute.mockReturnValue('abc123');
  serverRuntime.stopContainer('abc123', 5);
  expect(execute).toHaveBeenCalledExactlyOnceWith('docker', ['stop', '--time', '5', 'abc123'], expect.objectContaining({ timeout: 15_000 }));
});
