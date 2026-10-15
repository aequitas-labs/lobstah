import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addTodo, closeTodo, listTodos, openTodosByGrounds, staleTodoNote, staleTodos, TodoError } from '../src/todos.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const DAY = 24 * 3600 * 1000;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todos-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('helm todos: storage per grounds', () => {
  it('adds free text with created and updated times; done and drop close and stamp updated', () => {
    const t0 = Date.parse('2026-10-01T10:00:00Z');
    const a = addTodo('fleet', 'merge #2268 once the API is in production (API first)', t0);
    const b = addTodo('fleet', 'tag runner 1.4.1', t0 + 1000);
    expect(a).toMatchObject({ id: 1, text: 'merge #2268 once the API is in production (API first)', state: 'open', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' });
    expect(b.id).toBe(2);
    expect(listTodos('fleet').map((t) => t.id)).toEqual([1, 2]);

    const done = closeTodo('fleet', 1, 'done', t0 + DAY);
    expect(done).toMatchObject({ state: 'done', createdAt: a.createdAt, updatedAt: new Date(t0 + DAY).toISOString() });
    closeTodo('fleet', 2, 'dropped', t0 + DAY);
    expect(listTodos('fleet')).toEqual([]);
    expect(listTodos('fleet', { all: true }).map((t) => t.state)).toEqual(['done', 'dropped']);
    expect(() => closeTodo('fleet', 1, 'dropped')).toThrow(TodoError);
    expect(() => closeTodo('fleet', 9, 'done')).toThrow(/no todo 9/);

    // Ids are never reused, even after closing.
    expect(addTodo('fleet', 'next', t0 + DAY).id).toBe(3);
  });

  it('keeps each grounds apart, and survives a fresh read from disk', () => {
    addTodo('fleet', 'home item');
    addTodo('web', 'web item');
    expect(listTodos('web').map((t) => t.text)).toEqual(['web item']);
    expect(openTodosByGrounds().map((g) => [g.grounds, g.todos.length])).toEqual([['fleet', 1], ['web', 1]]);
    expect(fs.existsSync(path.join(home, 'todos', 'web.json'))).toBe(true);
  });

  it('prunes closed items a month after they closed; open ones stay', () => {
    const t0 = Date.parse('2026-08-01T00:00:00Z');
    addTodo('fleet', 'old open', t0);
    addTodo('fleet', 'old done', t0);
    closeTodo('fleet', 2, 'done', t0);
    addTodo('fleet', 'new', t0 + 40 * DAY);
    expect(listTodos('fleet', { all: true }).map((t) => t.text)).toEqual(['old open', 'new']);
  });

  it('refuses empty text and a grounds name that is a path', () => {
    expect(() => addTodo('fleet', '  ')).toThrow(TodoError);
    expect(() => addTodo('../x', 'a')).toThrow(TodoError);
  });
});

describe('helm todos: stale', () => {
  it('counts open items older than the configured days; 0 disables', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    addTodo('fleet', 'four days', now - 4 * DAY);
    addTodo('fleet', 'two days', now - 2 * DAY);
    const todos = listTodos('fleet');
    expect(staleTodos(todos, 3, now).map((t) => t.text)).toEqual(['four days']);
    expect(staleTodos(todos, 1, now)).toHaveLength(2);
    expect(staleTodos(todos, 0, now)).toEqual([]);
    expect(staleTodoNote(3, 3)).toBe('3 todos older than 3 days: move to the issue tracker?');
    expect(staleTodoNote(1, 1)).toBe('1 todo older than 1 day: move to the issue tracker?');
    expect(staleTodoNote(0, 3)).toBeUndefined();
  });
});
