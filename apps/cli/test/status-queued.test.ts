import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, queuedDescriptor } from '@lobstah/core';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-queued-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

describe('a queued dispatch reports queued and its queue time', () => {
  const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  it('dispatch writes queuedAt; status and ls print queued', () => {
    const out = lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'w');
    expect(out.status, out.stderr).toBe(0);
    const stamped = queuedDescriptor(id, 'work')!.queuedAt!;
    expect(out.stdout).toContain(`queued: ${stamped}`);

    const status = lobstah('status', id);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('state: queued');
    expect(status.stdout).toContain(`queued: ${stamped}`);

    const ls = lobstah('ls');
    expect(ls.stdout).toMatch(new RegExp(`${id},work,queue,queued,${stamped.replace(/\./g, '\\.')}`));
  });
});
