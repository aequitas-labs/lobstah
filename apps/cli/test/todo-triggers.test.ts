import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addWatch, answerDecision, askDecision, claimNext, enqueue, ensureLayout, fireDueTodos, listTodos, parsePrRef, prEvidence, readWatch, takeHelm, upsertPr, type GhPrView } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = 'todo-trigger-helm';
let home: string;
let ghStub: string;

/** Cross-platform `gh pr view` responses, intercepted before executable lookup. */
const fakeGh = (state: string): void => {
  fs.writeFileSync(path.join(home, 'gh-view.json'), JSON.stringify({ state, isDraft: false, headRefOid: 'abc', statusCheckRollup: [] }));
};
const run = (args: string[], hook?: Record<string, unknown>) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX')));
  return spawnSync(process.execPath, ['--require', ghStub, cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...env, LOBSTAH_HOME: home },
    timeout: 20_000,
    input: hook ? JSON.stringify({ cwd: home, ...hook }) : undefined,
  });
};
const add = (...args: string[]) => run(['todo', 'add', 'Wait for it', ...args]);
const printed = (out: { stdout: string; stderr: string }) => out.stdout + out.stderr;
const seedPr = (number: number, state: string) => {
  const ref = parsePrRef(`o/r#${number}`)!;
  upsertPr(prEvidence(ref, { state, isDraft: false, headRefOid: 'abc' } as GhPrView, new Date().toISOString()));
  return ref.key;
};
const stored = () => listTodos('fleet');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-trigger-cli-'));
  process.env.LOBSTAH_HOME = home;
  ghStub = path.join(home, 'gh-stub.cjs');
  // A shell script on PATH is not executable by Windows spawnSync. Stub the
  // Node subprocess boundary so no platform can fall through to the real gh.
  fs.writeFileSync(ghStub, `
    const childProcess = require('node:child_process');
    const originalSpawn = childProcess.spawnSync;
    childProcess.spawnSync = function(command, args, options) {
      if (command !== 'gh') return originalSpawn(command, args, options);
      if (args[0] === 'api' && args[1] === 'graphql') return { status: 0, signal: null, pid: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: '' };
      if (args[0] !== 'pr' || args[1] !== 'view') throw new Error('Unexpected gh call in todo trigger test');
      const missing = args[2] === '404';
      return { status: missing ? 1 : 0, signal: null, pid: 0,
        stdout: missing ? '' : require('node:fs').readFileSync(require('node:path').join(__dirname, 'gh-view.json'), 'utf8'),
        stderr: missing ? 'no such pull request' : '' };
    };
    require('node:module').syncBuiltinESMExports();
  `);
  ensureLayout();
  fakeGh('OPEN');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('todo add --when: refusals store nothing', () => {
  it.each([
    [['--when', 'deploy:prod done'], 'it watches card:, dispatch:, pr: and trap:'],
    [['--when', 'ume:abc'], 'it watches card:, dispatch:, pr: and trap:'],
    [['--when', 'card:ab12cd34'], 'no card decision:ab12cd34'],
    [['--when', 'dispatch:nope done'], 'no dispatch nope'],
    [['--when', 'dispatch:nope working'], 'needs a verb'],
    [['--when', 'trap:no-such free'], 'no trap named "no-such"'],
    [['--when', 'pr:nope merged'], 'not a PR reference'],
    [['--when', 'pr:o/r#404 merged'], `GitHub can't read pr:o/r#404`],
    [['--when', 'pr:o/r#1 merged', '--when-all', 'pr:o/r#2 merged'], '--when means any and --when-all means all'],
    [['--every', 'daily 09:00', '--when', 'pr:o/r#1 merged'], "--every stands alone: a repeat can't also wait on an event"],
    [['--every', 'daily 09:00', '--when-all', 'pr:o/r#1 merged'], "--every stands alone: a repeat can't also wait on an event"],
  ])('%j', (flags, message) => {
    const out = add(...flags);
    expect(out.status, printed(out)).toBe(2);
    expect(printed(out)).toContain(message);
    expect(stored()).toEqual([]);
    expect(readWatch('pr:o/r#404')).toBeUndefined();
  });
});

describe('todo add --when: a PR trigger', () => {
  it('registers a helm-owned watch on an open PR with none, and says so', () => {
    const out = add('--when', 'pr:o/r#7 merged');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).toContain('watching pr:o/r#7: also wakes the helm on failing checks and requested changes');
    expect(readWatch('pr:o/r#7')?.owner).toBe('man');
    expect(stored()[0]!.triggers).toEqual({ mode: 'any', items: [{ kind: 'pr', key: 'pr:o/r#7', on: 'merged' }] });
  });

  it('leaves an existing watch and its owner alone, and doesn’t mention one', () => {
    seedPr(7, 'OPEN');
    addWatch('pr:o/r#7', 'true', { owner: 'dispatch:someone' });
    const out = add('--when', 'pr:o/r#7 merged');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).not.toContain('watching');
    expect(readWatch('pr:o/r#7')?.owner).toBe('dispatch:someone');
  });

  it('registers one watch when two triggers name the same PR', () => {
    const out = add('--when', 'pr:o/r#7 merged', '--when', 'pr:o/r#7 closed');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout.match(/watching pr:o\/r#7/g)).toHaveLength(1);
  });

  it('a merged PR gets no watch, says it’s already true, and fires on the next check', () => {
    fakeGh('MERGED');
    const out = add('--when', 'pr:o/r#7 merged');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).toContain('already: merged');
    expect(out.stdout).not.toContain('watching');
    expect(readWatch('pr:o/r#7')).toBeUndefined();
    expect(fireDueTodos().fired).toBe(1);
  });

  it('a closed PR gets no watch and emits todo-due with the actual outcome', () => {
    takeHelm({ sessionId: SESSION, grounds: { name: 'fleet', repos: [] }, ttlMs: 60_000, identity: { harness: 'claude' } });
    fakeGh('CLOSED');
    const out = add('--when', 'pr:o/r#7 merged', '--session', SESSION);
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).toContain('already: closed without merging');
    expect(readWatch('pr:o/r#7')).toBeUndefined();
    const woke = run(['man', 'wait', '--session', SESSION, '--timeout', '1']);
    expect(woke.stdout).toContain('event: todo-due');
    expect(woke.stdout).toContain('pr:o/r#7 closed without merging');
    expect(woke.stdout).not.toContain('firedBy: pr:o/r#7 merged');
  });

  it('a refused trigger beside a good one registers no watch', () => {
    const out = add('--when', 'pr:o/r#7 merged', '--when', 'deploy:prod done');
    expect(out.status).toBe(2);
    expect(readWatch('pr:o/r#7')).toBeUndefined();
    expect(stored()).toEqual([]);
  });
});

describe('todo add --when: the verbs and views', () => {
  it('--when-all with --at stores both, and prints the time and what it waits on', () => {
    seedPr(1, 'OPEN');
    seedPr(2, 'OPEN');
    addWatch('pr:o/r#1', 'true', { owner: 'man' });
    addWatch('pr:o/r#2', 'true', { owner: 'man' });
    const out = add('--when-all', 'pr:o/r#1 green', '--when-all', 'pr:o/r#2 green', '--at', '2099-11-06T14:00Z');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).toContain('pr:o/r#1 green · pr:o/r#2 green (all)');
    expect(out.stdout).toMatch(/due: "?\w{3} Nov 6/);
    expect(stored()[0]).toMatchObject({ dueAt: '2099-11-06T14:00:00.000Z', triggers: { mode: 'all' } });
  });

  it('todo ls shows a waiting column, and fired: once it has fired', () => {
    seedPr(1, 'OPEN');
    addWatch('pr:o/r#1', 'true', { owner: 'man' });
    add('--when', 'pr:o/r#1 merged');
    const waiting = run(['todo', 'ls']);
    expect(waiting.stdout).toContain('waiting');
    expect(waiting.stdout).toContain('pr:o/r#1 merged (any)');

    seedPr(1, 'MERGED');
    fireDueTodos();
    const fired = run(['todo', 'ls']);
    expect(fired.stdout).toContain('fired: pr:o/r#1 merged');
    expect(fired.stdout).toContain('✓ pr:o/r#1 merged (any)');
    const { todos } = JSON.parse(run(['todo', 'ls', '--json']).stdout) as { todos: Array<{ overdue: boolean; firedBy: string; waitingOn: string }> };
    expect(todos[0]).toMatchObject({ overdue: true, firedBy: 'pr:o/r#1 merged', waitingOn: '✓ pr:o/r#1 merged (any)' });
  });

  it('a card answered wakes man wait with a todo-due naming what happened', () => {
    takeHelm({ sessionId: SESSION, grounds: { name: 'fleet', repos: [] }, ttlMs: 60_000, identity: { harness: 'claude' } });
    const { meta } = askDecision({ title: 'Ship?', grounds: 'fleet', askedBy: 'helm', maxBytes: 1024 });
    const out = run(['todo', 'add', 'Tell Sam', '--when', `card:${meta.key}`, '--session', SESSION]);
    expect(out.status, printed(out)).toBe(0);
    answerDecision({ key: meta.key, text: 'Yes', by: 'cli', now: new Date(), maxBytes: 1024 });
    const woke = run(['man', 'wait', '--session', SESSION, '--timeout', '1']);
    expect(woke.stdout).toContain('event: todo-due');
    expect(woke.stdout).toContain(`card:${meta.key} answered`);
  });

  it('a dispatch trigger resolves a real dispatch', () => {
    enqueue({ id: 'real-one', repo: 'r', brief: 'b' });
    claimNext('work');
    const out = add('--when', 'dispatch:real-one done');
    expect(out.status, printed(out)).toBe(0);
    expect(out.stdout).toContain('dispatch:real-one done (any)');
  });

  it('snooze keeps a trigger listening, and the todo keeps what it waits on', () => {
    seedPr(1, 'OPEN');
    addWatch('pr:o/r#1', 'true', { owner: 'man' });
    add('--when', 'pr:o/r#1 merged');
    expect(run(['todo', 'snooze', '1', '--until', '2d']).status).toBe(0);
    expect(stored()[0]!.triggers!.items).toHaveLength(1);
    seedPr(1, 'MERGED');
    expect(fireDueTodos().fired).toBe(1);
    expect(stored()[0]!.firing!.cause).toEqual({ kind: 'event', triggers: ['pr:o/r#1 merged'] });
  });

  it('a daemon firing error is reported per grounds without stopping the others', () => {
    seedPr(1, 'MERGED');
    fs.mkdirSync(path.join(home, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(home, 'todos', 'broken.json'), '{ nope');
    addWatch('pr:o/r#1', 'true', { owner: 'man' });
    add('--when', 'pr:o/r#1 merged');
    const result = fireDueTodos();
    expect(result.fired).toBe(1);
    expect(result.errors.join()).toContain('todos for broken:');
  });
});
