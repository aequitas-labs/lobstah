import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, ensureLayout, queuedDescriptor, storedDescriptor } from '@lobstah/core';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-explicit-'));
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

describe('dispatch and swap record an explicit --harness / --model', () => {
  it('dispatch --harness writes harnessExplicit; without it the field is absent', () => {
    const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    expect(lobstah('dispatch', '--repo', 'r', '--id', a, '--brief-text', 'w', '--harness', 'claude', '--model', 'claude-opus-5-5').status).toBe(0);
    expect(queuedDescriptor(a, 'work')).toMatchObject({ harness: 'claude', harnessExplicit: true, modelExplicit: true });

    expect(lobstah('dispatch', '--repo', 'r', '--id', b, '--brief-text', 'w').status).toBe(0);
    const plain = queuedDescriptor(b, 'work')!;
    expect(plain.harness).toBeUndefined();
    expect('harnessExplicit' in plain).toBe(false);
    expect('modelExplicit' in plain).toBe(false);
  });

  it('swap --harness writes harnessExplicit', () => {
    const a = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    expect(lobstah('dispatch', '--repo', 'r', '--id', a, '--brief-text', 'w').status).toBe(0);
    claimNext('work');
    const swapped = lobstah('swap', a, '--harness', 'codex');
    expect(swapped.status, swapped.stdout).toBe(0);
    expect(storedDescriptor(a, 'work')).toMatchObject({ harness: 'codex', harnessExplicit: true });
    expect(storedDescriptor(a, 'work')?.modelExplicit).toBeUndefined();
  });
});
