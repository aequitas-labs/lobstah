import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryDirLock } from '../src/dir-lock.js';
import { claimTodoFirings, completeTodo, fireDueTodos, peekTodoFirings, skipTodo } from '../src/todo-fire.js';
import { addTodo, closeTodo, listTodos, snoozeTodo, staleTodos, todoOverdue, todoScheduled, todosRoot, TodoError, type TodoRecurrence } from '../src/todos.js';
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

describe('a repeating todo', () => {
  const NY = 'America/New_York';
  const daily = { cadence: 'daily', at: '09:00' } as const;
  /** Thursday 09:00 in New York, and that same time on later days. */
  const THU_9AM = Date.parse('2026-11-05T14:00:00Z');
  const at9 = (days: number) => THU_9AM + days * DAY;
  const series = (every: TodoRecurrence = daily, dueAt = at9(0)) =>
    addTodo('g', 'standup', THU_9AM - DAY, { dueAt: due(dueAt), every });
  const only = () => listTodos('g', { all: true })[0]!;

  it('done stays open at the first occurrence after now, and records lastDoneAt', () => {
    series();
    fireDueTodos(at9(0), NY);
    const done = completeTodo('g', 1, at9(0) + HOUR, NY);
    expect(done).toMatchObject({ state: 'open', dueAt: due(at9(1)), lastDoneAt: due(at9(0) + HOUR) });
    expect(done.firing).toBeUndefined();
  });

  it('done early passes the coming occurrence: Friday’s done on Thursday passes that Friday', () => {
    series({ cadence: 'weekly', day: 'fri', at: '09:00' }, at9(1));
    const done = completeTodo('g', 1, at9(0), NY);
    expect(done.dueAt).toBe(due(at9(8)));
  });

  it('skip moves to that same occurrence and leaves lastDoneAt unchanged', () => {
    series();
    fireDueTodos(at9(0), NY);
    const skipped = skipTodo('g', 1, at9(0) + HOUR, NY);
    expect(skipped).toMatchObject({ state: 'open', dueAt: due(at9(1)) });
    expect(skipped.lastDoneAt).toBeUndefined();
    expect(skipped.firing).toBeUndefined();

    completeTodo('g', 1, at9(1), NY);
    const lastDone = only().lastDoneAt;
    expect(skipTodo('g', 1, at9(2), NY).lastDoneAt).toBe(lastDone);
  });

  it('skip refuses a todo that doesn’t repeat', () => {
    addTodo('g', 'one-off', T0);
    expect(() => skipTodo('g', 1, T0, NY)).toThrow("todo 1 doesn't repeat: snooze it or drop it");
  });

  it('three missed occurrences give one firing naming the newest', () => {
    series();
    expect(fireDueTodos(at9(3) + HOUR, NY).fired).toBe(1);
    expect(only().dueAt).toBe(due(at9(3)));
    expect(only().firing).toMatchObject({ firedAt: due(at9(3) + HOUR), cause: { kind: 'time', dueAt: due(at9(3)) } });
    expect(fireDueTodos(at9(3) + 2 * HOUR, NY).fired).toBe(0);
    expect(claimTodoFirings('g', at9(3) + 2 * HOUR, NY)).toHaveLength(1);
  });

  it('an ignored series fires again at each new occurrence, and wakes again', () => {
    series();
    fireDueTodos(at9(0), NY);
    expect(claimTodoFirings('g', at9(0), NY)).toHaveLength(1);
    expect(claimTodoFirings('g', at9(0) + HOUR, NY)).toHaveLength(0);

    expect(fireDueTodos(at9(1) - 1, NY).fired).toBe(0);
    expect(fireDueTodos(at9(1), NY).fired).toBe(1);
    const [event] = claimTodoFirings('g', at9(1), NY);
    expect(event).toMatchObject({ id: 1, repeats: true, firedAt: due(at9(1)) });
  });

  it('a snoozed occurrence fires at its new time, then done moves past it', () => {
    series();
    fireDueTodos(at9(0), NY);
    snoozeTodo('g', 1, due(at9(0) + 5 * HOUR), at9(0) + HOUR);
    expect(fireDueTodos(at9(0) + 2 * HOUR, NY).fired).toBe(0);
    expect(fireDueTodos(at9(0) + 5 * HOUR, NY).fired).toBe(1);
    expect(only().firing!.cause.dueAt).toBe(due(at9(0) + 5 * HOUR));
    expect(completeTodo('g', 1, at9(0) + 6 * HOUR, NY).dueAt).toBe(due(at9(1)));
  });

  it('a done before a later snooze time moves past that time', () => {
    series();
    snoozeTodo('g', 1, due(at9(2) + HOUR), at9(0));
    expect(completeTodo('g', 1, at9(0) + HOUR, NY).dueAt).toBe(due(at9(3)));
  });

  it('weekdays carry over the weekend', () => {
    series({ cadence: 'weekdays', at: '09:00' }, at9(1));
    expect(completeTodo('g', 1, at9(1), NY).dueAt).toBe(due(at9(4)));
  });

  it('drop ends a series', () => {
    series();
    expect(closeTodo('g', 1, 'dropped', at9(0))).toMatchObject({ state: 'dropped' });
    expect(fireDueTodos(at9(5), NY).fired).toBe(0);
  });

  it('done on a todo with no repeat rule moves it to state done', () => {
    addTodo('g', 'one-off', T0, { dueAt: due(T0 + HOUR) });
    const done = completeTodo('g', 1, T0, NY);
    expect(done.state).toBe('done');
    expect(done.lastDoneAt).toBeUndefined();
  });
});
