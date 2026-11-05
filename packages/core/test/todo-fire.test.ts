import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryDirLock } from '../src/dir-lock.js';
import { claimTodoFirings, fireDueTodos, peekTodoFirings } from '../src/todo-fire.js';
import { addTodo, closeTodo, listTodos, snoozeTodo, staleTodos, todoOverdue, todoScheduled, todosRoot, TodoError } from '../src/todos.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const T0 = Date.parse('2026-11-05T15:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const due = (ms: number) => new Date(ms).toISOString();
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-fire-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('firing a todo once', () => {
  it('records no firing before its time, and one at it', () => {
    addTodo('g', 'later', T0, { dueAt: due(T0 + HOUR) });
    expect(fireDueTodos(T0 + HOUR - 1).fired).toBe(0);
    expect(listTodos('g')[0]!.firing).toBeUndefined();

    expect(fireDueTodos(T0 + HOUR).fired).toBe(1);
    expect(listTodos('g')[0]!.firing).toEqual({ firedAt: due(T0 + HOUR), cause: { kind: 'time', dueAt: due(T0 + HOUR) } });
  });

  it('a second pass records nothing and keeps the first firing', () => {
    addTodo('g', 'later', T0, { dueAt: due(T0 + HOUR) });
    fireDueTodos(T0 + HOUR);
    expect(fireDueTodos(T0 + 2 * HOUR).fired).toBe(0);
    expect(listTodos('g')[0]!.firing!.firedAt).toBe(due(T0 + HOUR));
  });

  it('never fires a todo with no time, or a closed one', () => {
    addTodo('g', 'no time', T0);
    const closed = addTodo('g', 'closed', T0, { dueAt: due(T0 + HOUR) });
    closeTodo('g', closed.id, 'done', T0);
    expect(fireDueTodos(T0 + DAY).fired).toBe(0);
  });

  it('a claim hands each firing to one wake; a peek leaves it', () => {
    addTodo('g', 'later', T0, { dueAt: due(T0 + HOUR) });
    fireDueTodos(T0 + HOUR);

    expect(peekTodoFirings('g', 'UTC').map((e) => e.id)).toEqual([1]);
    expect(peekTodoFirings('g', 'UTC').map((e) => e.id)).toEqual([1]);

    const [event] = claimTodoFirings('g', T0 + HOUR, 'UTC');
    expect(event).toMatchObject({ grounds: 'g', id: 1, text: 'later', firedAt: due(T0 + HOUR), firedBy: 'due Thu Nov 5, 16:00 UTC' });
    expect(claimTodoFirings('g', T0 + 2 * HOUR, 'UTC')).toEqual([]);
    expect(peekTodoFirings('g', 'UTC')).toEqual([]);
  });

  it('several firings come out in one claim, and only for that grounds', () => {
    addTodo('g', 'a', T0, { dueAt: due(T0 + 1) });
    addTodo('g', 'b', T0, { dueAt: due(T0 + 2) });
    addTodo('other', 'c', T0, { dueAt: due(T0 + 3) });
    fireDueTodos(T0 + HOUR);
    expect(claimTodoFirings('g', T0 + HOUR).map((e) => e.text)).toEqual(['a', 'b']);
    expect(peekTodoFirings('other').map((e) => e.text)).toEqual(['c']);
  });
});

describe('snoozing a todo', () => {
  it('holds the new due and no firing, and can fire again at the new time', () => {
    addTodo('g', 'retry', T0, { dueAt: due(T0 + HOUR) });
    fireDueTodos(T0 + HOUR);
    claimTodoFirings('g', T0 + HOUR);

    const snoozed = snoozeTodo('g', 1, due(T0 + DAY), T0 + 2 * HOUR);
    expect(snoozed).toMatchObject({ dueAt: due(T0 + DAY), snoozes: 1, updatedAt: due(T0 + 2 * HOUR) });
    expect(snoozed.firing).toBeUndefined();

    expect(fireDueTodos(T0 + 3 * HOUR).fired).toBe(0);
    expect(fireDueTodos(T0 + DAY).fired).toBe(1);
    expect(claimTodoFirings('g', T0 + DAY).map((e) => e.id)).toEqual([1]);
  });

  it('setting a first time is not a snooze; moving one is', () => {
    addTodo('g', 'plain', T0);
    expect(snoozeTodo('g', 1, due(T0 + DAY), T0).snoozes).toBeUndefined();
    expect(snoozeTodo('g', 1, due(T0 + 2 * DAY), T0).snoozes).toBe(1);
    expect(snoozeTodo('g', 1, due(T0 + 3 * DAY), T0).snoozes).toBe(2);
  });

  it('refuses a closed or unknown todo', () => {
    addTodo('g', 'x', T0);
    closeTodo('g', 1, 'done', T0);
    expect(() => snoozeTodo('g', 1, due(T0 + DAY), T0)).toThrow('todo 1 is already done');
    expect(() => snoozeTodo('g', 9, due(T0 + DAY), T0)).toThrow('no todo 9');
  });
});

describe('quiet before due, overdue after it', () => {
  it('a todo with a future due is never stale, whatever its age', () => {
    const old = T0 - 30 * DAY;
    addTodo('g', 'scheduled', old, { dueAt: due(T0 + HOUR) });
    addTodo('g', 'plain', old);
    expect(staleTodos(listTodos('g'), 3, T0).map((t) => t.text)).toEqual(['plain']);
  });

  it('past its due it is overdue and still not stale', () => {
    addTodo('g', 'scheduled', T0 - 30 * DAY, { dueAt: due(T0 - HOUR) });
    const [todo] = listTodos('g');
    expect(todoOverdue(todo!, T0)).toBe(true);
    expect(todoScheduled(todo!, T0)).toBe(false);
    expect(staleTodos(listTodos('g'), 3, T0)).toEqual([]);
  });

  it('ahead of its due it is scheduled and not overdue', () => {
    addTodo('g', 'scheduled', T0, { dueAt: due(T0 + HOUR) });
    const [todo] = listTodos('g');
    expect(todoOverdue(todo!, T0)).toBe(false);
    expect(todoScheduled(todo!, T0)).toBe(true);
  });

  it('a closed todo is neither', () => {
    addTodo('g', 'x', T0, { dueAt: due(T0 - HOUR) });
    const closed = closeTodo('g', 1, 'done', T0);
    expect(todoOverdue(closed, T0)).toBe(false);
    expect(todoScheduled(closed, T0)).toBe(false);
  });
});

describe('a file written before due times', () => {
  it('keeps its ids and text, stays stale by age, and never fires', () => {
    fs.mkdirSync(todosRoot(), { recursive: true });
    const old = due(T0 - 10 * DAY);
    const file = { nextId: 8, items: [{ id: 7, text: 'old one', state: 'open', createdAt: old, updatedAt: old }] };
    fs.writeFileSync(path.join(todosRoot(), 'g.json'), JSON.stringify(file));

    expect(listTodos('g')).toEqual(file.items);
    expect(staleTodos(listTodos('g'), 3, T0).map((t) => t.id)).toEqual([7]);
    expect(fireDueTodos(T0).fired).toBe(0);
    expect(addTodo('g', 'next', T0).id).toBe(8);
  });
});

describe('a damaged file is left intact', () => {
  const damaged = '{ "nextId": 3, "items": [ oops ';
  const file = () => path.join(todosRoot(), 'g.json');
  beforeEach(() => {
    fs.mkdirSync(todosRoot(), { recursive: true });
    fs.writeFileSync(file(), damaged);
  });

  it('every writer refuses it and leaves the bytes alone', () => {
    expect(() => addTodo('g', 'x', T0)).toThrow(TodoError);
    expect(() => addTodo('g', 'x', T0)).toThrow(/is damaged, so nothing was changed/);
    expect(() => closeTodo('g', 1, 'done', T0)).toThrow(/is damaged/);
    expect(() => snoozeTodo('g', 1, due(T0 + DAY), T0)).toThrow(/is damaged/);
    expect(fs.readFileSync(file(), 'utf8')).toBe(damaged);
  });

  it('a file with no items list counts as damaged', () => {
    fs.writeFileSync(file(), '{"nextId":3}');
    expect(() => addTodo('g', 'x', T0)).toThrow(/no items list/);
  });

  it('the firing pass reports it, runs the other grounds, and leaves the bytes alone', () => {
    addTodo('other', 'due', T0, { dueAt: due(T0 + 1) });
    const result = fireDueTodos(T0 + HOUR);
    expect(result.fired).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('todos for g:');
    expect(fs.readFileSync(file(), 'utf8')).toBe(damaged);
  });

  it('a view still reads it as empty', () => {
    expect(listTodos('g')).toEqual([]);
  });
});

describe('the grounds lock', () => {
  it('a writer waits for the lock, then gives up with a message and changes nothing', () => {
    addTodo('g', 'first', T0);
    const held = tryDirLock(path.join(todosRoot(), 'g.json.lock'), { staleMs: 60_000 })!;
    try {
      expect(() => addTodo('g', 'second', T0)).toThrow('the todos for g are locked: try again');
    } finally {
      held.release(Date.now() + 1000);
    }
    expect(listTodos('g').map((t) => t.text)).toEqual(['first']);
    expect(addTodo('g', 'second', T0).id).toBe(2);
  });

  it('the lock directory is not taken for a grounds', () => {
    addTodo('g', 'first', T0, { dueAt: due(T0 + 1) });
    const held = tryDirLock(path.join(todosRoot(), 'g.json.lock'), { staleMs: 60_000 })!;
    try {
      const result = fireDueTodos(T0 + HOUR);
      expect(result.errors.join()).toContain('locked');
      expect(result.errors).toHaveLength(1);
    } finally {
      held.release(Date.now() + 1000);
    }
    expect(fireDueTodos(T0 + HOUR)).toEqual({ fired: 1, errors: [] });
  });
});
