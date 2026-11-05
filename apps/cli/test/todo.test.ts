import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo, ensureLayout, fireDueTodos, listTodos, loadConfig, resolveGrounds, signOnTrap, takeHelm } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = 'helm-session';
const DAY = 24 * 3600 * 1000;
let home: string;

/** The CLI with no harness session env; hook input on stdin when given. */
const run = (args: string[], input?: Record<string, unknown>) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...env, LOBSTAH_HOME: home },
    ...(input ? { input: JSON.stringify({ cwd: home, ...input }) } : {}),
    timeout: 20_000,
  });
};

const helm = () => {
  const cfg = loadConfig();
  takeHelm({ sessionId: HELM, grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000 });
  return resolveGrounds(cfg).name;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('helm todos: re-injected beside the charter', () => {
  for (const source of ['startup', 'compact'] as const) {
    it(`SessionStart (${source}) gives the helm its open todos`, () => {
      const grounds = helm();
      addTodo(grounds, 'merge #2268 once the API is in production, see https://github.com/o/r/pull/2268');
      addTodo(grounds, 'tag runner 1.4.1');
      const out = run(['hook', 'session-start'], { session_id: HELM, source });
      expect(out.status).toBe(0);
      const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('the helm charter');
      expect(ctx).toContain('[1] merge #2268 once the API is in production, see https://github.com/o/r/pull/2268 — added');
      expect(ctx).toContain('[2] tag runner 1.4.1');
      expect(ctx.indexOf('the helm charter')).toBeLessThan(ctx.indexOf('[1] merge'));
    });
  }

  it('a closed todo drops out; a session that is not the helm gets none', () => {
    const grounds = helm();
    addTodo(grounds, 'tag runner 1.4.1');
    expect(run(['todo', 'done', '1', '--session', HELM]).status).toBe(0);
    addTodo(grounds, 'still open');
    const ctx = JSON.parse(run(['hook', 'session-start'], { session_id: HELM, source: 'compact' }).stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('tag runner');
    expect(ctx).toContain('[2] still open');
    const other = JSON.parse(run(['hook', 'session-start'], { session_id: 'someone-else' }).stdout).hookSpecificOutput.additionalContext as string;
    expect(other).not.toContain('still open');
  });
});

describe('helm todos: helm only', () => {
  it('a trap session is refused; with a claimed helm, another session cannot write', () => {
    helm();
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree);
    signOnTrap({ sessionId: 'trap-session', harness: 'codex', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
    const trap = run(['todo', 'add', 'x', '--session', 'trap-session']);
    expect(trap.status).not.toBe(0);
    expect(trap.stdout + trap.stderr).toContain('a trap keeps none');
    expect(run(['todo', 'add', 'x', '--session', 'other-session']).status).not.toBe(0);
    expect(run(['todo', 'add', 'x', '--session', HELM]).status).toBe(0);
    // The text is the whole todo: no detail flags.
    expect(run(['todo', 'add', 'x', '--why', 'y', '--session', HELM]).status).toBe(2);
  });
});

describe('helm todos: the stale note in tend', () => {
  it('notes todos past the default 3 days, and lists them', () => {
    const grounds = helm();
    const now = Date.now();
    addTodo(grounds, 'old one', now - 4 * DAY);
    addTodo(grounds, 'older one', now - 5 * DAY);
    addTodo(grounds, 'fresh one', now - 1 * DAY);
    const r = buildTendReport(now);
    expect(r.todoNote).toBe('2 todos older than 3 days: move to the issue tracker?');
    expect(r.todos?.map((t) => [t.text, t.stale])).toEqual([['old one', true], ['older one', true], ['fresh one', false]]);
    const text = renderTend(r);
    expect(text).toContain('2 todos older than 3 days: move to the issue tracker?');
    expect(text).toContain('fresh one');
  });

  it('follows [helm].todoStaleDays; none stale, no note', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntodoStaleDays = 7\n');
    const grounds = helm();
    addTodo(grounds, 'four days', Date.now() - 4 * DAY);
    const r = buildTendReport();
    expect(r.todoNote).toBeUndefined();
    expect(renderTend(r)).not.toContain('older than');
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntodoStaleDays = 1\n');
    expect(buildTendReport().todoNote).toBe('1 todo older than 1 day: move to the issue tracker?');
  });
});

describe('todo verbs: times', () => {
  const add = (...args: string[]) => run(['todo', 'add', ...args]);

  it('add --at and --in print the resolved time in full and store it', () => {
    const at = add('Check the numbers', '--at', '2099-11-06T14:00Z');
    expect(at.status, at.stderr).toBe(0);
    expect(at.stdout).toMatch(/due: "?\w{3} Nov 6, \d{2}:00/);
    const within = add('Retry', '--in', '2h');
    expect(within.status, within.stderr).toBe(0);
    const stored = listTodos('fleet');
    expect(stored[0]!.dueAt).toBe('2099-11-06T14:00:00.000Z');
    expect(Date.parse(stored[1]!.dueAt!)).toBeGreaterThan(Date.now() + 3600_000);
  });

  it.each([
    [['--at', 'next week'], 'as a time: try'],
    [['--at', '2020-01-01 09:00'], 'has passed: give a time ahead'],
    [['--at', 'fri 9am'], 'use 24-hour time: "fri 09:00"'],
    [['--in', 'soon'], 'as a duration: try'],
    [['--at', 'fri 09:00', '--in', '2h'], '--at and --in both set the time'],
  ])('refuses %j with exit 2 and stores nothing', (flags, message) => {
    const out = add('Nope', ...flags);
    expect(out.status).toBe(2);
    expect(out.stdout + out.stderr).toContain(message);
    expect(listTodos('fleet')).toEqual([]);
  });

  it('snooze holds the new due and no firing, and prints it in full', () => {
    addTodo('fleet', 'Retry', Date.now() - DAY, { dueAt: new Date(Date.now() - 1000).toISOString() });
    fireDueTodos();
    expect(listTodos('fleet')[0]!.firing).toBeDefined();
    const out = run(['todo', 'snooze', '1', '--until', '2099-11-06T14:00Z']);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/due: "?\w{3} Nov 6, \d{2}:00/);
    const [todo] = listTodos('fleet');
    expect(todo!.dueAt).toBe('2099-11-06T14:00:00.000Z');
    expect(todo!.firing).toBeUndefined();
  });

  it('snooze refuses a bad time, a missing --until and an unknown id, changing nothing', () => {
    addTodo('fleet', 'Retry');
    expect(run(['todo', 'snooze', '1', '--until', 'whenever']).status).toBe(2);
    expect(run(['todo', 'snooze', '1']).status).toBe(2);
    expect(run(['todo', 'snooze', '9', '--until', '2h']).status).toBe(2);
    expect(listTodos('fleet')[0]!.dueAt).toBeUndefined();
  });

  it('todo ls lists overdue first and waiting last, with the due column only when used', () => {
    const plainOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-plain-'));
    try {
      const env = { ...process.env, LOBSTAH_HOME: plainOnly };
      fs.mkdirSync(path.join(plainOnly, 'todos'), { recursive: true });
      fs.writeFileSync(path.join(plainOnly, 'todos', 'fleet.json'), JSON.stringify({ nextId: 2, items: [{ id: 1, text: 'plain', state: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
      const before = spawnSync(process.execPath, [cli, 'todo', 'ls'], { cwd: plainOnly, encoding: 'utf8', env });
      expect(before.stdout).toContain('{id,text,added}');
    } finally {
      removeTempDir(plainOnly);
    }

    addTodo('fleet', 'waiting', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    addTodo('fleet', 'plain', Date.now());
    addTodo('fleet', 'overdue', Date.now() - DAY, { dueAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    addTodo('fleet', 'stale', Date.now() - 10 * DAY);
    const out = run(['todo', 'ls']);
    expect(out.stdout).toContain('{id,text,due,added}');
    const order = ['overdue', 'stale', 'plain', 'waiting'].map((word) => out.stdout.indexOf(`,${word},`));
    expect(order.every((at) => at >= 0), out.stdout).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.stdout).toMatch(/overdue,overdue 2\.0h/);
  });

  it('shows how often a todo has been snoozed, only when it has', () => {
    addTodo('fleet', 'moved', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    expect(run(['todo', 'ls']).stdout).not.toContain('snoozes');
    run(['todo', 'snooze', '1', '--until', '2d']);
    expect(run(['todo', 'ls']).stdout).toContain('{id,text,due,snoozes,added}');
  });

  it('the view reports stale false before due and overdue true after, with the storage name', () => {
    addTodo('fleet', 'ahead', Date.now() - 30 * DAY, { dueAt: new Date(Date.now() + DAY).toISOString() });
    addTodo('fleet', 'behind', Date.now() - 30 * DAY, { dueAt: new Date(Date.now() - DAY).toISOString() });
    const { todos } = JSON.parse(run(['todo', 'ls', '--json']).stdout) as { todos: Array<{ text: string; stale: boolean; overdue: boolean; groundsKey: string }> };
    expect(todos.find((t) => t.text === 'ahead')).toMatchObject({ stale: false, overdue: false, groundsKey: 'fleet' });
    expect(todos.find((t) => t.text === 'behind')).toMatchObject({ stale: false, overdue: true });
  });

  it('the brief keeps future and snoozed todos named even when the unscheduled limit is zero', () => {
    const grounds = helm();
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\nbriefTodoLimit = 0\n');
    addTodo(grounds, 'waiting one', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    const snoozed = addTodo(grounds, 'waiting two', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    expect(run(['todo', 'snooze', String(snoozed.id), '--until', '2d', '--session', HELM]).status).toBe(0);
    addTodo(grounds, 'plain one', Date.now());
    addTodo(grounds, 'late one', Date.now() - DAY, { dueAt: new Date(Date.now() - 1000).toISOString() });
    const out = run(['hook', 'session-start'], { session_id: HELM, source: 'startup' });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('late one — added');
    expect(ctx).toContain('[overdue]');
    expect(ctx).toContain('waiting one');
    expect(ctx).toContain('waiting two');
    expect(ctx).toContain('[due ');
    expect(ctx).toContain('; snoozed 1]');
    expect(ctx).not.toContain('plain one');
    expect(ctx).not.toContain('scheduled (lobstah todo ls)');
    expect(ctx).toContain('… and 1 more (lobstah todo ls)');
  });

  it.each(['tend', 'report'])('man %s keeps the full list with future and snoozed due times', (surface) => {
    const grounds = helm();
    addTodo(grounds, 'Future follow-up', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    const snoozed = addTodo(grounds, 'Snoozed follow-up', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    expect(run(['todo', 'snooze', String(snoozed.id), '--until', '2d', '--session', HELM]).status).toBe(0);
    const out = run(['man', surface, ...(surface === 'report' ? ['--session', HELM] : [])]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.stdout).toContain('Future follow-up');
    expect(out.stdout).toContain('Snoozed follow-up');
    expect(out.stdout).toContain('due,snoozes');
  });

  it('tend lists overdue first, with one count line, and waiting last', () => {
    addTodo('fleet', 'waiting', Date.now(), { dueAt: new Date(Date.now() + DAY).toISOString() });
    addTodo('fleet', 'plain', Date.now());
    addTodo('fleet', 'late', Date.now() - DAY, { dueAt: new Date(Date.now() - 1000).toISOString() });
    const text = renderTend(buildTendReport());
    expect(text).toContain('1 todo overdue: do, snooze or drop it');
    expect(text.indexOf(',late,')).toBeLessThan(text.indexOf(',plain,'));
    expect(text.indexOf(',plain,')).toBeLessThan(text.indexOf(',waiting,'));
  });
});

describe('todo verbs: repeats', () => {
  it('add --every prints the next time and the rule, and stores both', () => {
    const out = run(['todo', 'add', 'Check the numbers', '--every', 'weekly fri 09:00']);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('every: weekly fri 09:00');
    const [todo] = listTodos('fleet');
    expect(todo!.every).toEqual({ cadence: 'weekly', day: 'fri', at: '09:00' });
    expect(Date.parse(todo!.dueAt!)).toBeGreaterThan(Date.now());
  });

  it.each([
    [['--every', 'daily 09:00', '--at', 'fri 09:00'], '--every stands alone'],
    [['--every', 'daily 09:00', '--in', '2h'], '--every stands alone'],
    [['--every', 'weekly'], '--every needs a schedule and a time'],
  ])('refuses %j with exit 2 and stores nothing', (flags, message) => {
    const out = run(['todo', 'add', 'Nope', ...flags]);
    expect(out.status).toBe(2);
    expect(out.stdout + out.stderr).toContain(message);
    expect(listTodos('fleet')).toEqual([]);
  });

  it('done keeps a series open and prints what comes next; skip does the same; drop ends it', () => {
    run(['todo', 'add', 'Standup', '--every', 'daily 09:00']);
    const firstDue = listTodos('fleet')[0]!.dueAt!;

    const done = run(['todo', 'done', '1']);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain('state: open');
    expect(done.stdout).toContain('next:');
    expect(listTodos('fleet')[0]!.lastDoneAt).toBeDefined();
    const secondDue = listTodos('fleet')[0]!.dueAt!;
    expect(Date.parse(secondDue)).toBeGreaterThan(Date.parse(firstDue));

    const lastDone = listTodos('fleet')[0]!.lastDoneAt;
    const skip = run(['todo', 'skip', '1']);
    expect(skip.status, skip.stderr).toBe(0);
    expect(Date.parse(listTodos('fleet')[0]!.dueAt!)).toBeGreaterThan(Date.parse(secondDue));
    expect(listTodos('fleet')[0]!.lastDoneAt).toBe(lastDone);

    expect(run(['todo', 'drop', '1']).status).toBe(0);
    expect(listTodos('fleet')).toEqual([]);
  });

  it('skip refuses a one-off with the plan’s message', () => {
    addTodo('fleet', 'one-off');
    const out = run(['todo', 'skip', '1']);
    expect(out.status).toBe(2);
    expect(out.stdout + out.stderr).toContain("todo 1 doesn't repeat: snooze it or drop it");
  });

  it('todo ls shows an every column only when a todo repeats', () => {
    addTodo('fleet', 'plain');
    expect(run(['todo', 'ls']).stdout).not.toContain('every');
    run(['todo', 'add', 'Standup', '--every', 'weekdays 09:00']);
    const out = run(['todo', 'ls']);
    expect(out.stdout).toContain('{id,text,due,every,added}');
    expect(out.stdout).toContain('weekdays 09:00');
  });
});
