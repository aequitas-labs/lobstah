import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, ensureLayout, laneDirs, readStatusLog, unhandled } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI: a message that arrives while a worker
// works is read before the worker may report done.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-unread-done-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}

/** A dispatched, claimed dispatch with a live runner: a send goes to its inbox. */
function live(id: string) {
  expect(lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work').status).toBe(0);
  expect(claimNext('work')).toBe(id);
  fs.writeFileSync(path.join(laneDirs('work').active, id, 'runner.json'), JSON.stringify({ pid: process.pid }));
}

describe('report done with an unread message', () => {
  it('prints the message, marks it read, refuses, and writes nothing; the next done succeeds', () => {
    live(A);
    expect(lobstah('report', A, 'working', 'on it').status).toBe(0);
    expect(lobstah('send', A, '--no-reply', 'also update the changelog').status).toBe(0);
    expect(unhandled(A, 'work')).toHaveLength(1);

    const refused = lobstah('report', A, 'done', 'all finished');
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('also update the changelog');
    expect(refused.stdout + refused.stderr).toContain('not reported done: 1 unread message(s)');
    expect(readStatusLog(A, 'work').map((e) => e.verb)).not.toContain('done');
    expect(unhandled(A, 'work')).toEqual([]);

    const done = lobstah('report', A, 'done', 'changelog updated too');
    expect(done.status, done.stderr).toBe(0);
    expect(readStatusLog(A, 'work').at(-1)?.verb).toBe('done');
  });

  it('other verbs report as before with a message unread', () => {
    live(A);
    expect(lobstah('send', A, '--no-reply', 'a note').status).toBe(0);
    expect(lobstah('report', A, 'working', 'still going').status).toBe(0);
    expect(lobstah('report', A, 'failed', 'gave up').status).toBe(0);
    expect(unhandled(A, 'work')).toHaveLength(1);
  });
});
