import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  answeredAt, appendStatus, claimNext, complete, ensureLayout, laneDirs, queuedDescriptor,
  storedDescriptor, takeHelm, unhandled, unhandledTrapMessages,
} from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-send-follow-up-'));
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
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

function dispatch(id: string, followUp?: string) {
  const res = lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work', ...(followUp ? ['--follow-up', followUp] : []));
  expect(res.status, res.stdout).toBe(0);
}

function finish(id: string) {
  expect(claimNext('work')).toBe(id);
  appendStatus(id, 'work', 'done', 'finished');
  complete(id, 'work');
}

function startedId(stdout: string): string {
  const id = /started: follow-up ([0-9a-f-]+) of/.exec(stdout)?.[1];
  expect(id, stdout).toBeDefined();
  return id!;
}

describe('send wakes a finished dispatch', () => {
  it('delivers to a live runner, then to queued work, without creating a dispatch', () => {
    dispatch(A);
    expect(claimNext('work')).toBe(A);
    fs.writeFileSync(path.join(laneDirs('work').active, A, 'runner.json'), JSON.stringify({ pid: process.pid }));
    const active = lobstah('send', A, 'steer');
    expect(active.status, active.stdout).toBe(0);
    expect(active.stdout).toContain(`delivered: inbox of ${A}`);
    expect(unhandled(A, 'work')[0]?.text).toContain('steer');

    dispatch(B, A);
    fs.rmSync(path.join(laneDirs('work').active, A, 'runner.json'));
    const queued = lobstah('send', A, 'next');
    expect(queued.status, queued.stdout).toBe(0);
    expect(queued.stdout).toContain(`delivered: inbox of ${B} (queued)`);
    expect(unhandled(B, 'work')[0]?.text).toContain('next');
  });

  it('follows the newest finished chain member, carries the brief and attachments, and reuses the queued follow-up', () => {
    dispatch(A);
    finish(A);
    expect(lobstah('status', A).stdout).toContain(`lobstah send ${A} "<instruction>"`);
    expect(lobstah('catch', A).stdout).toContain(`lobstah send ${A} "<instruction>"`);
    dispatch(B, A);
    finish(B);
    const file = path.join(home, 'note.txt');
    fs.writeFileSync(file, 'evidence');
    const first = lobstah('send', A, 'continue', '--attach', file);
    expect(first.status, first.stdout).toBe(0);
    const next = startedId(first.stdout);
    const descriptor = queuedDescriptor(next, 'work')!;
    expect(descriptor.followUp).toBe(B);
    expect(descriptor.brief).toBe(`Follow-up instruction from terminal on dispatch ${B}:\ncontinue`);
    expect(descriptor.attachments?.some((a) => a.name === 'note.txt')).toBe(true);
    expect(descriptor.harnessExplicit).not.toBe(true);
    expect(descriptor.model).toBeUndefined();
    const second = lobstah('send', A, 'one more');
    expect(second.stdout).toContain(`delivered: inbox of ${next} (queued)`);
    expect(unhandled(next, 'work')[0]?.text).toContain('one more');
    expect(unhandled(next, 'work')).toHaveLength(1);
    expect(storedDescriptor(next, 'work')).toBeDefined();
  });

  it('keeps a signed-on trap sticky, and falls back to a headless worker when it is gone', () => {
    dispatch(A);
    finish(A);
    const done = path.join(laneDirs('work').done, A);
    fs.writeFileSync(path.join(done, 'claim.json'), JSON.stringify({ by: 'wt:seat' }));
    fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({
      trapId: 'seat', worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 's',
      signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), firstParkedAt: new Date().toISOString(),
    }));
    const sticky = lobstah('send', A, 'again');
    expect(queuedDescriptor(startedId(sticky.stdout), 'work')?.for).toBe('wt:seat');
    fs.rmSync(path.join(home, 'soaking', 'seat.json'));
    const queuedId = startedId(sticky.stdout);
    expect(claimNext('work')).toBe(queuedId);
    appendStatus(queuedId, 'work', 'done');
    complete(queuedId, 'work');
    const headless = lobstah('send', A, 'third');
    expect(headless.stdout).toContain('headless worker');
    expect(queuedDescriptor(startedId(headless.stdout), 'work')?.for).toBeUndefined();
  });

  it('delivers to a live trap claim; dispatch chooses an explicit follow-up address', () => {
    dispatch(A);
    expect(claimNext('work')).toBe(A);
    fs.writeFileSync(path.join(laneDirs('work').active, A, 'claim.json'), JSON.stringify({ by: 'wt:seat' }));
    fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({
      trapId: 'seat', worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 's', claimed: A,
      signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), firstParkedAt: new Date().toISOString(),
    }));
    const active = lobstah('send', A, 'steer trap');
    expect(active.stdout).toContain(`delivered: inbox of ${A}`);
    expect(unhandled(A, 'work')[0]?.text).toContain('steer trap');
    expect(lobstah('send', 'wt:seat', 'direct').status).toBe(0);
    expect(lobstah('send', 'session:s', 'alias').status).toBe(0);
    expect(unhandledTrapMessages('seat').map((message) => message.text).join(' ')).toContain('alias');
    appendStatus(A, 'work', 'done');
    complete(A, 'work');
    const sent = lobstah('dispatch', '--repo', 'r', '--follow-up', A, '--brief-text', 'next', '--for', 'wt:seat', '--harness', 'codex', '--model', 'm', '--id', B);
    expect(sent.status, sent.stdout).toBe(0);
    expect(queuedDescriptor(B, 'work')?.for).toBe('wt:seat');
    expect(queuedDescriptor(B, 'work')?.harness).toBe('codex');
    expect(queuedDescriptor(B, 'work')?.model).toBe('m');
  });

  it('turns an answer to a stranded question into a follow-up and clears the question', () => {
    dispatch(A);
    expect(claimNext('work')).toBe(A);
    const at = new Date(Date.now() - 1000).toISOString();
    appendStatus(A, 'work', 'needs-decision', 'Choose?', at);
    const answer = lobstah('send', A, 'choose blue');
    expect(answer.status, answer.stdout).toBe(0);
    expect(queuedDescriptor(startedId(answer.stdout), 'work')?.brief).toContain('choose blue');
    expect(answeredAt(A, 'work', at)).toBeDefined();
  });

  it('rejects removed send flags and preserves the helm gate', () => {
    dispatch(A);
    finish(A);
    for (const flags of [['--no-wake'], ['--harness', 'codex'], ['--model', 'm'], ['--for', 'wt:seat']]) {
      const rejected = lobstah('send', A, 'note', ...flags);
      expect(rejected.status).toBe(2);
      expect(rejected.stdout).toContain('unknown flag');
    }
    takeHelm({ sessionId: 'helm-session', grounds: { name: 'fleet', repos: ['r'] }, ttlMs: 60_000 });
    const refused = lobstah('send', A, 'cannot');
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('helm');
    const allowed = lobstah('send', A, 'can', '--session', 'helm-session');
    expect(allowed.status, allowed.stdout).toBe(0);
    expect(queuedDescriptor(startedId(allowed.stdout), 'work')).toBeDefined();
  });

  it('rejects an unknown dispatch', () => {
    const sent = lobstah('send', A, 'hello');
    expect(sent.status).not.toBe(0);
    expect(sent.stdout).toContain(`unknown dispatch ${A}`);
  });
});
