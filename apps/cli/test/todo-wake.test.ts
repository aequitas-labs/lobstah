import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo, ensureLayout, listTodos, takeHelm, todosRoot } from '@lobstah/core';
import { readCursor } from '../src/reported.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = 'todo-wake-helm';
const HOUR = 3600_000;
let home: string;

const environment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX'))),
  LOBSTAH_HOME: home,
});
const run = (args: string[], hook?: Record<string, unknown>) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: environment(),
    encoding: 'utf8',
    timeout: 20_000,
    input: hook ? JSON.stringify({ cwd: home, ...hook }) : undefined,
  });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const seat = (grounds = 'fleet', sessionId = SESSION): void => {
  takeHelm({ sessionId, grounds: { name: grounds, repos: [] }, ttlMs: 60_000, identity: { harness: 'claude' } });
};
const wait = (...flags: string[]) => run(['man', 'wait', '--session', SESSION, ...flags]);
const stop = () => run(['hook', 'stop'], { session_id: SESSION });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-wake-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "UTC"\npassIntervalSecs = 0\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('man wait delivers a due todo', () => {
  it('prints one todo-due event naming the id, then nothing the second time', () => {
    seat();
    run(['man', 'wait', '--session', SESSION, '--peek']); // a first pass out of the way
    addTodo('fleet', 'Retry the staging deploy', Date.now() - HOUR, { dueAt: ago(1000) });

    const first = wait('--timeout', '1');
    expect(first.stdout.match(/event: todo-due/g)).toHaveLength(1);
    expect(first.stdout).toContain('todo: 1');
    expect(first.stdout).toContain('text: Retry the staging deploy');
    expect(first.stdout).toMatch(/firedBy: "?due /);
    expect(first.stdout).toContain('`lobstah todo done 1`');
    expect(first.stdout).toContain('`lobstah todo snooze 1 --until <time>`');
    expect(first.status).toBe(0);

    const second = wait('--timeout', '1');
    expect(second.stdout).not.toContain('todo-due');
    expect(second.status).toBe(3);
  });

  it('wakes from the loop when a todo comes due during the wait', () => {
    seat();
    run(['man', 'wait', '--session', SESSION, '--peek']);
    addTodo('fleet', 'Soon', Date.now(), { dueAt: ahead(2000) });
    const woke = wait('--timeout', '30');
    expect(woke.status).toBe(0);
    expect(woke.stdout).toContain('event: todo-due');
  });

  it('--peek shows it without claiming; the real wait still gets it', () => {
    seat();
    addTodo('fleet', 'Peeked', Date.now() - HOUR, { dueAt: ago(1000) });
    expect(wait('--peek').stdout).toContain('event: todo-due');
    expect(wait('--peek').stdout).toContain('event: todo-due');
    expect(wait('--timeout', '1').stdout).toContain('event: todo-due');
    expect(wait('--peek').stdout).not.toContain('event: todo-due');
  });

  it('a helm hears only its own grounds', () => {
    seat('fleet');
    addTodo('other-grounds', 'Not yours', Date.now() - HOUR, { dueAt: ago(1000) });
    const out = wait('--timeout', '1');
    expect(out.stdout).not.toContain('Not yours');
    expect(listTodos('other-grounds')[0]!.firing?.deliveredAt).toBeUndefined();
  });

  it('does not move the digest cursor', () => {
    seat();
    const cursor = readCursor('fleet');
    addTodo('fleet', 'Due', Date.now() - HOUR, { dueAt: ago(1000) });
    expect(wait('--timeout', '1').stdout).toContain('event: todo-due');
    expect(readCursor('fleet')).toBe(cursor);
  });

  it('a damaged todo file never fails the wait', () => {
    seat();
    fs.mkdirSync(todosRoot(), { recursive: true });
    const file = path.join(todosRoot(), 'fleet.json');
    fs.writeFileSync(file, '{ damaged');
    const out = wait('--timeout', '1');
    expect(out.status).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ damaged');
  });

  it('a wait with no helm uses the one grounds `todo add` would use', () => {
    addTodo('fleet', 'No helm', Date.now() - HOUR, { dueAt: ago(1000) });
    const out = run(['man', 'wait', '--timeout', '1']);
    expect(out.stdout).toContain('event: todo-due');
  });
});

describe('the Stop hook delivers a due todo', () => {
  it('blocks once with the todo, with nothing in flight, then lets the turn end', () => {
    seat();
    wait('--peek');
    stop(); // a pass due at sign-on is out of the way
    addTodo('fleet', 'Tell Sam', Date.now() - HOUR, { dueAt: ago(1000) });

    const first = stop();
    const reason = JSON.parse(first.stdout.trim().split('\n').at(-1)!) as { decision: string; reason: string };
    expect(reason.decision).toBe('block');
    expect(reason.reason).toContain('todo-due 1: Tell Sam');
    expect(listTodos('fleet')[0]!.firing?.deliveredAt).toBeDefined();

    expect(stop().stdout).not.toContain('todo-due');
    expect(wait('--timeout', '1').stdout).not.toContain('todo-due');
  });
});

describe('two helms writing at once', () => {
  it('loses no todo and reuses no id', async () => {
    const add = (text: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [cli, 'todo', 'add', text], { cwd: home, env: environment(), stdio: 'ignore' });
        child.on('exit', (code) => resolve(code ?? -1));
      });
    const texts = Array.from({ length: 12 }, (_, i) => `todo ${i}`);
    const codes = await Promise.all(texts.map(add));
    expect(codes.every((code) => code === 0)).toBe(true);
    const stored = listTodos('fleet');
    expect(stored.map((t) => t.text).sort()).toEqual([...texts].sort());
    expect(new Set(stored.map((t) => t.id)).size).toBe(texts.length);
  }, 30_000);
});
