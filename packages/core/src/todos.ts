import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDirLock } from './dir-lock.js';
import { goalDate } from './goals.js';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';

/**
 * The helm's todo list: reminders the helm keeps for itself ("merge #2268
 * once the API is in production"), stored per grounds so they outlive the
 * conversation. One file per grounds, `todos/<grounds>.json`. The helm, the
 * daemon and the glass write it, each under the grounds' lock; a trap never
 * gets todos.
 */

export type TodoState = 'open' | 'done' | 'dropped';

export interface Todo {
  /** Short and sequential per grounds: `todo done 3`. Never reused. */
  id: number;
  /** Free text: the helm writes whatever detail it wants. */
  text: string;
  state: TodoState;
  createdAt: string;
  updatedAt: string;
  /** The next attempt, an ISO instant. Absent: no time trigger. */
  dueAt?: string;
  /** Set once when the todo fires; cleared by a snooze. */
  firing?: TodoFiring;
  /** How many times a time already set has been moved, shown beside the todo. */
  snoozes?: number;
}

/** One firing. Its existence is what stops a second one for this due. */
export interface TodoFiring {
  firedAt: string;
  cause: TodoFireCause;
  /** Claimed by a helm wake. Unset means the next wake delivers it. */
  deliveredAt?: string;
}

/** Why a todo fired. */
export type TodoFireCause = { kind: 'time'; dueAt: string };

/**
 * One todo as tend, `man report`, and the glass show it: an open one, or one
 * done since the last day boundary (shown checked until the day rolls over).
 */
export interface TodoView {
  /** The grounds, as displayed. */
  grounds: string;
  /** The storage name of the grounds, which glass writes need; `grounds` is display only. */
  groundsKey: string;
  id: number;
  text: string;
  createdAt: string;
  /** Marked done today; it drops off at the next 04:00-local boundary. */
  done: boolean;
  /** Open, with no due time, and older than `[helm].todoStaleDays`. */
  stale: boolean;
  dueAt?: string;
  /** Open and past its due, or fired and not yet cleared. */
  overdue: boolean;
  /** What fired it, in words. */
  firedBy?: string;
  snoozes?: number;
}

/** The todos of one grounds as stored. Writers change it through `updateTodoFile`. */
export interface TodoFile {
  nextId: number;
  items: Todo[];
}

export class TodoError extends Error {}

/** Closed items stay this long for `todo ls --all`, then go on the next write. */
const CLOSED_KEEP_MS = 30 * 24 * 3600 * 1000;
const GROUNDS_RE = /^[A-Za-z0-9._-]+$/;
/** A lock older than this was left by a dead process: a write takes milliseconds. */
const LOCK_STALE_MS = 30_000;
/** Writers are brief, so a wait this long means something is wrong. */
const LOCK_WAIT_MS = 2_000;

export function todosRoot(): string {
  return path.join(lobstahHome(), 'todos');
}

function todosFile(grounds: string): string {
  if (!GROUNDS_RE.test(grounds) || grounds.startsWith('.')) throw new TodoError(`not a grounds name: ${grounds}`);
  return path.join(todosRoot(), `${grounds}.json`);
}

/** The stored shape of parsed JSON, or undefined when it isn't a todo file. */
function todoFileShape(parsed: unknown): TodoFile | undefined {
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Partial<TodoFile>).items)) return undefined;
  const raw = parsed as Partial<TodoFile> & { items: Todo[] };
  const nextId = typeof raw.nextId === 'number' ? raw.nextId : Math.max(0, ...raw.items.map((t) => t.id)) + 1;
  return { nextId, items: raw.items };
}

/** For showing todos: an absent or damaged file reads as empty, so a view never fails on it. */
function read(grounds: string): TodoFile {
  try {
    return todoFileShape(JSON.parse(fs.readFileSync(todosFile(grounds), 'utf8'))) ?? { nextId: 1, items: [] };
  } catch (err) {
    if (err instanceof TodoError) throw err;
    return { nextId: 1, items: [] };
  }
}

/**
 * For writing: an absent file is empty, but a file that is present and can't
 * be read refuses, so a write never replaces todos a typo has hidden.
 */
export function readTodoFile(grounds: string): TodoFile {
  const file = todosFile(grounds);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { nextId: 1, items: [] };
    throw new TodoError(`can't read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TodoError(`${file} is damaged, so nothing was changed: fix it by hand (${err instanceof Error ? err.message : String(err)})`);
  }
  const shaped = todoFileShape(parsed);
  if (!shaped) throw new TodoError(`${file} is damaged, so nothing was changed: fix it by hand (no items list)`);
  return shaped;
}

function write(grounds: string, data: TodoFile, now: number): void {
  const file = todosFile(grounds);
  data.items = data.items.filter((t) => t.state === 'open' || now - (Date.parse(t.updatedAt) || 0) < CLOSED_KEEP_MS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  atomicRenameSync(tmp, file);
}

/**
 * Change one grounds' todos under its lock: read, apply `change`, write. The
 * write happens only when `change` returns a result other than undefined.
 */
export function updateTodoFile<T>(grounds: string, now: number, change: (data: TodoFile) => T | undefined): T | undefined {
  const file = todosFile(grounds);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withDirLock(
    `${file}.lock`,
    () => {
      const data = readTodoFile(grounds);
      const result = change(data);
      if (result !== undefined) write(grounds, data, now);
      return result;
    },
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, busy: () => new TodoError(`the todos for ${grounds} are locked: try again`) },
  );
}

/** Open todos oldest first; `all` adds closed ones still kept. */
export function listTodos(grounds: string, opts: { all?: boolean } = {}): Todo[] {
  return read(grounds).items.filter((t) => opts.all || t.state === 'open');
}

/** What a new todo can carry besides its text. */
export interface NewTodoFields {
  dueAt?: string;
}

export function addTodo(grounds: string, text: string, now = Date.now(), fields: NewTodoFields = {}): Todo {
  text = text.trim();
  if (!text) throw new TodoError('a todo needs text');
  return updateTodoFile(grounds, now, (data) => {
    const at = new Date(now).toISOString();
    const todo: Todo = {
      id: data.nextId,
      text,
      state: 'open',
      createdAt: at,
      updatedAt: at,
      ...(fields.dueAt ? { dueAt: fields.dueAt } : {}),
    };
    data.items.push(todo);
    data.nextId += 1;
    return todo;
  })!;
}

/** The open todo with this id, or a `TodoError` naming why there isn't one. */
function openTodo(data: TodoFile, id: number): Todo {
  const todo = data.items.find((t) => t.id === id);
  if (!todo) throw new TodoError(`no todo ${id} — \`lobstah todo ls\` lists them`);
  if (todo.state !== 'open') throw new TodoError(`todo ${id} is already ${todo.state}`);
  return todo;
}

/** Mark an open todo done or dropped. */
export function closeTodo(grounds: string, id: number, state: Exclude<TodoState, 'open'>, now = Date.now()): Todo {
  return updateTodoFile(grounds, now, (data) => {
    const todo = openTodo(data, id);
    todo.state = state;
    todo.updatedAt = new Date(now).toISOString();
    return todo;
  })!;
}

/**
 * Give an open todo a new due time and clear its firing, so it can wake the
 * helm again at that time. Moving a time already set counts as a snooze;
 * setting the first one doesn't.
 */
export function snoozeTodo(grounds: string, id: number, dueAt: string, now = Date.now()): Todo {
  return updateTodoFile(grounds, now, (data) => {
    const todo = openTodo(data, id);
    if (todo.dueAt !== undefined || todo.firing !== undefined) todo.snoozes = (todo.snoozes ?? 0) + 1;
    todo.dueAt = dueAt;
    delete todo.firing;
    todo.updatedAt = new Date(now).toISOString();
    return todo;
  })!;
}

/**
 * Whether a todo is still on the shown list: open ones always; a done one
 * until the next day boundary — 04:00 local, the one daily goals use
 * (`timezone` is `[helm].timezone`, else the system zone). A dropped one
 * never: it leaves the list at once.
 */
export function shownTodo(t: Todo, now = Date.now(), timezone?: string): boolean {
  if (t.state === 'open') return true;
  if (t.state !== 'done') return false;
  const at = Date.parse(t.updatedAt);
  return Number.isFinite(at) && goalDate(new Date(at), timezone) === goalDate(new Date(now), timezone);
}

/** Open todos plus those done today, oldest first. */
export function shownTodos(grounds: string, now = Date.now(), timezone?: string): Todo[] {
  return read(grounds).items.filter((t) => shownTodo(t, now, timezone));
}

/** The storage name of every grounds with a todo file. */
export function todoGrounds(): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(todosRoot());
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((g) => GROUNDS_RE.test(g))
    .sort();
}

/** Every grounds with a todo file, with its shown todos (open, or done today). */
export function shownTodosByGrounds(now = Date.now(), timezone?: string): Array<{ grounds: string; todos: Todo[] }> {
  return todoGrounds()
    .map((grounds) => ({ grounds, todos: shownTodos(grounds, now, timezone) }))
    .filter((g) => g.todos.length > 0);
}

/** Open todos created more than `days` ago, leaving out those with a due time. `days` 0 disables. */
export function staleTodos(todos: Todo[], days: number, now = Date.now()): Todo[] {
  if (!(days > 0)) return [];
  return todos.filter((t) => t.state === 'open' && t.dueAt === undefined && now - (Date.parse(t.createdAt) || now) > days * 24 * 3600 * 1000);
}

/** Open and past its due, or fired and not yet cleared. */
export function todoOverdue(t: Todo, now = Date.now()): boolean {
  if (t.state !== 'open') return false;
  return t.firing !== undefined || (t.dueAt !== undefined && Date.parse(t.dueAt) <= now);
}

/** Open and waiting for a time still ahead. */
export function todoScheduled(t: Todo, now = Date.now()): boolean {
  return t.state === 'open' && !todoOverdue(t, now) && t.dueAt !== undefined;
}

/** The tend count line for overdue todos, or undefined when none are. */
export function overdueTodoNote(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count} todo${count === 1 ? '' : 's'} overdue: do, snooze or drop ${count === 1 ? 'it' : 'them'}`;
}

/** The short tend note for stale todos, or undefined when none are. */
export function staleTodoNote(count: number, days: number): string | undefined {
  if (count === 0) return undefined;
  const d = `${days} day${days === 1 ? '' : 's'}`;
  return `${count} todo${count === 1 ? '' : 's'} older than ${d}: move to the issue tracker?`;
}

/** One line per todo, for the helm's context and plain text views. */
export function todoLine(t: Todo): string {
  return `- [${t.id}] ${t.text} — added ${t.createdAt.slice(0, 10)}`;
}
