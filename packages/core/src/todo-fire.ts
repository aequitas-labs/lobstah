import { formatTodoTime, latestOccurrenceBy, nextOccurrenceAfter } from './todo-time.js';
import { readTodoTrigger, todoTriggerLabel } from './todo-triggers.js';
import { openTodo, readTodoFile, todoGrounds, updateTodoFile, TodoError, type Todo, type TodoFireCause, type TodoTrigger } from './todos.js';

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

/** Why this todo's time means it should fire now, or undefined. A series names its newest passed occurrence. */
function timeCause(todo: Todo, now: number, timezone?: string): TodoFireCause | undefined {
  if (todo.dueAt === undefined) return undefined;
  const dueAt = Date.parse(todo.dueAt);
  if (dueAt > now) return undefined;
  if (!todo.every) return todo.firing ? undefined : { kind: 'time', dueAt: todo.dueAt };
  const newest = Math.max(dueAt, latestOccurrenceBy(todo.every, now, timezone));
  if (todo.firing?.cause.kind === 'time' && newest <= Date.parse(todo.firing.cause.dueAt)) return undefined;
  return { kind: 'time', dueAt: new Date(newest).toISOString() };
}

/**
 * Latch whatever has newly come true, and say what that fires. Each trigger
 * latches once, so one that fired stays quiet after a snooze while the unmet
 * ones keep listening. Mode all fires when its last one latches.
 */
function latchTriggers(todo: Todo, now: number): { latched: boolean; cause?: TodoFireCause } {
  const triggers = todo.triggers;
  if (!triggers || todo.firing) return { latched: false };
  const at = new Date(now).toISOString();
  const newly: string[] = [];
  let lost: string | undefined;
  for (const item of triggers.items) {
    if (item.metAt) continue;
    const reading = readTodoTrigger(item, todo.createdAt);
    if (reading.state === 'waiting') continue;
    item.metAt = at;
    item.metAs = reading.state === 'met' ? reading.as : 'lost';
    if (reading.state === 'lost') lost ??= todoTriggerLabel(item);
    else newly.push(triggerHappened(item, reading.as));
  }
  if (lost) return { latched: true, cause: { kind: 'lost', trigger: lost } };
  if (newly.length === 0) return { latched: false };
  if (triggers.mode === 'any') return { latched: true, cause: { kind: 'event', triggers: newly } };
  if (triggers.items.some((item) => !item.metAt)) return { latched: true };
  return { latched: true, cause: { kind: 'event', triggers: triggers.items.map((item) => triggerHappened(item, item.metAs!)) } };
}

/** A trigger and what happened to it, in words: `card:decision:ab12cd34 answered`. */
function triggerHappened(item: TodoTrigger, as: string): string {
  if (item.kind === 'pr') return `${item.key} ${as}`;
  return item.kind === 'card' ? `${todoTriggerLabel(item)} ${as}` : todoTriggerLabel(item);
}

/**
 * Bring one todo up to date: latch its triggers, then record a firing. Returns
 * whether anything changed. Triggers come first, so a time passing with
 * triggers unmet is what the deadline backstop means.
 */
function advanceTodo(todo: Todo, now: number, timezone?: string): { changed: boolean; fired: boolean } {
  if (todo.state !== 'open') return { changed: false, fired: false };
  const { latched, cause: triggerCause } = latchTriggers(todo, now);
  const cause = triggerCause ?? timeCause(todo, now, timezone);
  if (!cause) return { changed: latched, fired: false };
  if (cause.kind === 'time') todo.dueAt = cause.dueAt;
  todo.firing = { firedAt: new Date(now).toISOString(), cause };
  return { changed: true, fired: true };
}

/**
 * Bring every todo up to date. The first look works on a throwaway read, so a
 * grounds' lock is taken only when something changes; the same check then runs
 * again under the lock before writing.
 */
export function fireDueTodos(now = Date.now(), timezone?: string): TodoFireResult {
  const result: TodoFireResult = { fired: 0, errors: [] };
  for (const grounds of todoGrounds()) {
    try {
      if (!readTodoFile(grounds).items.some((todo) => advanceTodo(todo, now, timezone).changed)) continue;
      result.fired += updateTodoFile(grounds, now, (data) => {
        const outcomes = data.items.map((todo) => advanceTodo(todo, now, timezone));
        return outcomes.some((outcome) => outcome.changed) ? outcomes.filter((outcome) => outcome.fired).length : undefined;
      }) ?? 0;
    } catch (err) {
      result.errors.push(`todos for ${grounds}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** A firing's cause in words, for the event and the views. */
export function todoFiredBy(cause: TodoFireCause, timezone?: string): string {
  if (cause.kind === 'time') return `due ${formatTodoTime(cause.dueAt, timezone)}`;
  if (cause.kind === 'event') return cause.triggers.join(' · ');
  return `gone: ${cause.trigger}`;
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
