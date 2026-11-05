import { formatTodoTime, latestOccurrenceBy, nextOccurrenceAfter } from './todo-time.js';
import { openTodo, readTodoFile, todoGrounds, updateTodoFile, TodoError, type Todo, type TodoFireCause } from './todos.js';

/**
 * Firing todos, and handing each firing to its helm once. `fireDueTodos` runs
 * from the daemon's tick and from `man wait`; both may run at once, so a
 * firing is only ever written under the grounds' lock after checking again.
 */

/** A firing as `man wait` and the Stop hook deliver it. */
export interface TodoDueEvent {
  grounds: string;
  id: number;
  text: string;
  firedAt: string;
  firedBy: string;
  /** It repeats, so `todo skip` can pass this occurrence. */
  repeats: boolean;
}

/** What one pass over the todo files did. */
export interface TodoFireResult {
  fired: number;
  /** One message per grounds whose file couldn't be checked; the others still run. */
  errors: string[];
}

/**
 * Why this todo should fire now, or undefined when it shouldn't. A series
 * names its newest occurrence that has passed, so missed ones give one firing
 * with no backfill, and an ignored series fires again at each new occurrence.
 */
function fireCause(todo: Todo, now: number, timezone?: string): TodoFireCause | undefined {
  if (todo.state !== 'open' || todo.dueAt === undefined) return undefined;
  const dueAt = Date.parse(todo.dueAt);
  if (dueAt > now) return undefined;
  if (!todo.every) return todo.firing ? undefined : { kind: 'time', dueAt: todo.dueAt };
  const newest = Math.max(dueAt, latestOccurrenceBy(todo.every, now, timezone));
  if (todo.firing && newest <= Date.parse(todo.firing.cause.dueAt)) return undefined;
  return { kind: 'time', dueAt: new Date(newest).toISOString() };
}

/** Record a firing on every todo that should fire. Takes a grounds' lock only when one should. */
export function fireDueTodos(now = Date.now(), timezone?: string): TodoFireResult {
  const result: TodoFireResult = { fired: 0, errors: [] };
  for (const grounds of todoGrounds()) {
    try {
      if (!readTodoFile(grounds).items.some((todo) => fireCause(todo, now, timezone))) continue;
      result.fired += updateTodoFile(grounds, now, (data) => {
        let fired = 0;
        for (const todo of data.items) {
          const cause = fireCause(todo, now, timezone);
          if (!cause) continue;
          todo.dueAt = cause.dueAt;
          todo.firing = { firedAt: new Date(now).toISOString(), cause };
          fired += 1;
        }
        return fired > 0 ? fired : undefined;
      }) ?? 0;
    } catch (err) {
      result.errors.push(`todos for ${grounds}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** A firing's cause in words, for the event and the views. */
export function todoFiredBy(cause: TodoFireCause, timezone?: string): string {
  return `due ${formatTodoTime(cause.dueAt, timezone)}`;
}

function dueEvent(grounds: string, todo: Todo, timezone?: string): TodoDueEvent {
  return { grounds, id: todo.id, text: todo.text, firedAt: todo.firing!.firedAt, firedBy: todoFiredBy(todo.firing!.cause, timezone), repeats: todo.every !== undefined };
}

const undelivered = (todo: Todo): boolean => todo.state === 'open' && todo.firing !== undefined && todo.firing.deliveredAt === undefined;

/** The firings a helm hasn't been woken for, without claiming them: `man wait --peek`. */
export function peekTodoFirings(grounds: string, timezone?: string): TodoDueEvent[] {
  return readTodoFile(grounds).items.filter(undelivered).map((todo) => dueEvent(grounds, todo, timezone));
}

/**
 * Claim this grounds' undelivered firings for one wake. If the wait dies
 * between this and printing, that wake is lost, but the todo stays overdue and
 * shows at the next pass.
 */
export function claimTodoFirings(grounds: string, now = Date.now(), timezone?: string): TodoDueEvent[] {
  if (!readTodoFile(grounds).items.some(undelivered)) return [];
  return updateTodoFile(grounds, now, (data) => {
    const claimed = data.items.filter(undelivered);
    for (const todo of claimed) todo.firing!.deliveredAt = new Date(now).toISOString();
    return claimed.length > 0 ? claimed.map((todo) => dueEvent(grounds, todo, timezone)) : undefined;
  }) ?? [];
}

/**
 * Move a series past this occurrence: clear its firing and set its due to the
 * first occurrence after the later of now and its current due, so doing
 * Friday's on Thursday passes that Friday.
 */
function advanceSeries(todo: Todo, now: number, timezone?: string): void {
  const from = Math.max(now, Date.parse(todo.dueAt ?? '') || now);
  todo.dueAt = new Date(nextOccurrenceAfter(todo.every!, from, timezone)).toISOString();
  delete todo.firing;
  todo.updatedAt = new Date(now).toISOString();
}

/** `todo done`: a one-off closes; a series stays open and moves to its next occurrence. */
export function completeTodo(grounds: string, id: number, now = Date.now(), timezone?: string): Todo {
  return updateTodoFile(grounds, now, (data) => {
    const todo = openTodo(data, id);
    if (todo.every) {
      advanceSeries(todo, now, timezone);
      todo.lastDoneAt = new Date(now).toISOString();
    } else {
      todo.state = 'done';
      todo.updatedAt = new Date(now).toISOString();
    }
    return todo;
  })!;
}

/** `todo skip`: pass one occurrence of a series, as `done` would, without counting it as done. */
export function skipTodo(grounds: string, id: number, now = Date.now(), timezone?: string): Todo {
  return updateTodoFile(grounds, now, (data) => {
    const todo = openTodo(data, id);
    if (!todo.every) throw new TodoError(`todo ${id} doesn't repeat: snooze it or drop it`);
    advanceSeries(todo, now, timezone);
    return todo;
  })!;
}
