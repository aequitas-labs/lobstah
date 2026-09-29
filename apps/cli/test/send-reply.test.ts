import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus, awaitingReply, claimNext, complete, ensureLayout, laneDirs, markListed, readExpectation, takeHelm,
} from '@lobstah/core';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const helmSession = 'reply-helm';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-send-reply-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CODEX_THREAD_ID;
  return e;
}

function lobstah(args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(), timeout: 15_000, input });
}

/** A dispatched, claimed dispatch with a live runner: sends go to its inbox. */
function live(id: string) {
  const res = lobstah(['dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work']);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(claimNext('work')).toBe(id);
  fs.writeFileSync(path.join(laneDirs('work').active, id, 'runner.json'), JSON.stringify({ pid: process.pid }));
}

function send(...args: string[]) {
  const res = lobstah(['send', ...args]);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return res;
}

function report(id: string, verb: string, note: string) {
  const res = lobstah(['report', id, verb, note]);
  expect(res.status, res.stdout + res.stderr).toBe(0);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('a send expects a reply', () => {
  it('delivers the next working note once as a reply event', () => {
    live(A);
    send(A, 'start the dev server\nand report the URL');
    expect(readExpectation(A)).toMatchObject({ dispatchId: A, from: 'terminal', line: 'start the dev server' });
    expect(lobstah(['man', 'tend']).stdout).toContain('awaiting reply · ');

    report(A, 'working', 'dev server at http://localhost:3000');
    const first = lobstah(['man', 'wait', '--timeout', '1']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(count(first.stdout, 'event: reply')).toBe(1);
    expect(first.stdout).toContain(`id: ${A}`);
    expect(first.stdout).toContain('verb: working');
    expect(first.stdout).toContain('dev server at http://localhost:3000');
    expect(first.stdout).toContain('sent: start the dev server');
    expect(readExpectation(A)).toBeUndefined();
    expect(lobstah(['man', 'tend']).stdout).not.toContain('awaiting reply');

    report(A, 'working', 'still running');
    const second = lobstah(['man', 'wait', '--timeout', '1']);
    expect(second.status).toBe(3);
    expect(second.stdout).not.toContain('event: reply');
  });

  it('does not count a status entry lobstah writes itself as the reply', () => {
    live(A);
    send(A, 'check the build');
    appendStatus(A, 'work', 'working', 'operator message delivered');
    expect(awaitingReply(A)).toBeDefined();
    const res = lobstah(['man', 'wait', '--timeout', '1']);
    expect(res.status).toBe(3);
    expect(res.stdout).not.toContain('event: reply');
  });

  it('a done note wakes as done only and clears the expectation', async () => {
    live(A);
    send(A, 'finish up');
    const child = spawn(process.execPath, [cli, 'man', 'wait', '--session', 'waiter', '--timeout', '30'], { env: env() });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    // The wait registers its watcher at startup; give it time to take its baseline.
    const watcher = path.join(home, 'watchers', 'waiter.json');
    for (let i = 0; i < 100 && !fs.existsSync(watcher); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    report(A, 'done', 'shipped');
    const code = await exited;
    expect(code, out).toBe(0);
    expect(out).toContain('verb: done');
    expect(out).toContain('shipped');
    expect(out).not.toContain('event: reply');
    expect(readExpectation(A)).toBeUndefined();
  }, 40_000);

  it('--no-reply records nothing and delivers nothing', () => {
    live(A);
    const res = send(A, '--no-reply', 'use tabs');
    expect(res.stdout).not.toContain('reply: expected');
    expect(readExpectation(A)).toBeUndefined();
    report(A, 'working', 'switched to tabs');
    const wait = lobstah(['man', 'wait', '--timeout', '1']);
    expect(wait.status).toBe(3);
    expect(wait.stdout).not.toContain('event: reply');
  });

  it('a send to a finished dispatch attaches the expectation to its follow-up', () => {
    const res = lobstah(['dispatch', '--repo', 'r', '--id', A, '--brief-text', 'work']);
    expect(res.status).toBe(0);
    expect(claimNext('work')).toBe(A);
    appendStatus(A, 'work', 'done', 'finished');
    complete(A, 'work');
    const sent = send(A, 'one more thing');
    const next = /started: follow-up ([0-9a-f-]+) of/.exec(sent.stdout)?.[1];
    expect(next, sent.stdout).toBeDefined();
    expect(readExpectation(A)).toBeUndefined();
    expect(readExpectation(next!)).toMatchObject({ dispatchId: next, line: 'one more thing' });
    // The claim's own status entry is not the worker's note.
    expect(claimNext('work')).toBe(next);
    appendStatus(next!, 'work', 'working', 'fresh worktree');
    expect(awaitingReply(next!)).toBeDefined();
    report(next!, 'paused', 'waiting on CI');
    const wait = lobstah(['man', 'wait', '--timeout', '1']);
    expect(wait.stdout).toContain('event: reply');
    expect(wait.stdout).toContain('verb: paused');
  });
});

describe('man haul and an unanswered send', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `[repos.r]\npath = ${JSON.stringify(home.replace(/\\/g, '/'))}\ntrunk = "main"\n[helm]\narmGraceSecs = 0.2\n`,
    );
    takeHelm({ sessionId: helmSession, grounds: { name: 'fleet', repos: ['r'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
  });
  const haul = () => lobstah(['man', 'haul'], JSON.stringify({ session_id: helmSession }));

  it('lists the send as a standing item until the reply, then the reply', () => {
    live(A);
    send(A, '--session', helmSession, 'start the dev server\nthen report');
    const first = haul();
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: 'block' });
    expect(first.stdout).toMatch(new RegExp(`sent · ${A} · start the dev server · \\d+s`));

    // Re-listed when the reminder interval has passed, like a question.
    markListed(A, new Date(Date.now() - 3600_000).toISOString());
    expect(haul().stdout).toContain(`sent · ${A}`);
    markListed(A, new Date(Date.now() - 3600_000).toISOString());

    report(A, 'working', 'http://localhost:5173');
    const after = haul();
    expect(after.stdout).not.toContain('sent · ');
    expect(after.stdout).toContain(`reply ${A} (working)`);
    expect(after.stdout).toContain('http://localhost:5173');

    // Once man wait delivers the reply, nothing about the send stands.
    expect(lobstah(['man', 'wait', '--session', helmSession, '--timeout', '1']).stdout).toContain('event: reply');
    const settled = haul();
    expect(settled.stdout).not.toContain('sent · ');
    expect(settled.stdout).not.toContain('reply ');
  });
});
