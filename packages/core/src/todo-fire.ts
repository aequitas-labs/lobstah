import { formatTodoTime } from './todo-time.js';
import { readTodoFile, todoGrounds, updateTodoFile, type Todo, type TodoFireCause } from './todos.js';

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
}

/** What one pass over the todo files did. */
export interface TodoFireResult {
  fired: number;
  /** One message per grounds whose file couldn't be checked; the others still run. */
  errors: string[];
}

/** Why this todo should fire now, or undefined when it shouldn't. */
function fireCause(todo: Todo, now: number): TodoFireCause | undefined {
  if (todo.state !== 'open' || todo.firing || todo.dueAt === undefined) return undefined;
  return Date.parse(todo.dueAt) <= now ? { kind: 'time', dueAt: todo.dueAt } : undefined;
}

/** Record a firing on every todo that should fire. Takes a grounds' lock only when one should. */
export function fireDueTodos(now = Date.now()): TodoFireResult {
  const result: TodoFireResult = { fired: 0, errors: [] };
  for (const grounds of todoGrounds()) {
    try {
      if (!readTodoFile(grounds).items.some((todo) => fireCause(todo, now))) continue;
      result.fired += updateTodoFile(grounds, now, (data) => {
        let fired = 0;
        for (const todo of data.items) {
          const cause = fireCause(todo, now);
          if (!cause) continue;
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
  return { grounds, id: todo.id, text: todo.text, firedAt: todo.firing!.firedAt, firedBy: todoFiredBy(todo.firing!.cause, timezone) };
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
