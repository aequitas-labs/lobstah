import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createCodexAdapter, resolveCodexCli } from '../src/codex.js';
import { removeTempDir } from '../../../test/temp-dir.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-path-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

function executable(name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

function lookup(stdout: string, status: number | null = 0) {
  return vi.mocked(childProcess.spawnSync).mockReturnValue({ stdout, status, stderr: '', pid: 1, output: [], signal: null });
}

const options = () => ({ cwd: dir, env: {} });

describe('headless Codex binary selection', () => {
  it('uses which codex with the worker PATH and chooses the first result', () => {
    const file = executable(process.platform === 'win32' ? 'path-codex.exe' : 'path-codex');
    const find = lookup(`${file}\n/other/codex\n`);
    expect(resolveCodexCli({ ...options(), env: { PATH: '/worker/bin' } })).toBe(file);
    expect(find).toHaveBeenCalledWith(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], expect.objectContaining({
      cwd: dir, env: expect.objectContaining({ PATH: '/worker/bin' }),
    }));
  });

  it('prefers an explicit path, including spaces and paths relative to the job', () => {
    const file = executable('chosen codex');
    const find = lookup('/other/codex\n');
    expect(resolveCodexCli({ ...options(), codexCliPath: file })).toBe(file);
    expect(resolveCodexCli({ ...options(), codexCliPath: './chosen codex' })).toBe(file);
    expect(find).not.toHaveBeenCalled();
  });

  it('finds Codex when the worker PATH has no which executable', () => {
    const file = executable(process.platform === 'win32' ? 'codex.exe' : 'codex');
    const find = lookup('', 1);
    find.mockReturnValue({ stdout: '', stderr: '', status: null, signal: null, pid: 0, output: [], error: new Error('spawn which ENOENT') });
    expect(resolveCodexCli({ ...options(), env: { PATH: dir } })).toBe(file);
  });

  it('rejects a missing or directory override instead of silently changing binaries', () => {
    const find = lookup('/other/codex\n');
    for (const codexCliPath of ['missing', dir]) {
      expect(() => resolveCodexCli({ ...options(), codexCliPath })).toThrow('Check [harness.codex].cli_path');
    }
    expect(find).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects an explicit non-executable file', () => {
    fs.writeFileSync(path.join(dir, 'plain-file'), '');
    expect(() => resolveCodexCli({ ...options(), codexCliPath: 'plain-file' })).toThrow('not executable');
  });

  it.each([{ stdout: '', status: 1 }, { stdout: '', status: 0 }, { stdout: '', status: null }])('warns before the bundled fallback when lookup returns %j', ({ stdout, status }) => {
    lookup(stdout, status);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCodexCli(options())).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using the bundled CLI'));
  });

  it.skipIf(process.platform === 'win32')('passes the selected executable to the actual SDK', async () => {
    vi.stubEnv('LOBSTAH_HOME', path.join(dir, 'home'));
    const cli = executable('fake codex');
    const argvLog = path.join(dir, 'argv.json');
    fs.writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume();
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({type:'thread.started', thread_id:'selected-cli'}));
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'selected binary ran'}}));
});\n`);
    lookup(`${cli}\n`);
    const run = await createCodexAdapter().start({ ...options(), id: 'path-test', prompt: 'go', model: 'gpt-6.1-sol', limits: {}, flags: [] });
    run.end();
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(await run.done).toEqual({ sessionId: 'selected-cli' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', data: { text: 'selected binary ran' } }));
    expect(JSON.parse(fs.readFileSync(argvLog, 'utf8'))).toContain('gpt-6.1-sol');
  });
});
