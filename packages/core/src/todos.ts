import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';

/**
 * The helm's to-do list: reminders the helm keeps for itself ("merge #2268
 * once the API is in production"), stored per grounds so they outlive the
 * conversation. One file per grounds, `todos/<grounds>.json`. Only the helm
 * writes it; a trap never gets to-dos.
 */

export type TodoState = 'open' | 'done' | 'dropped';

export interface Todo {
  /** Short and sequential per grounds: `todo done 3`. Never reused. */
  id: number;
  text: string;
  why?: string;
  /** A URL, a PR (`#123`, `owner/repo#123`), or a dispatch id. */
  ref?: string;
  state: TodoState;
  createdAt: string;
  updatedAt: string;
}

/** One open to-do as tend, `man report`, and the glass show it. */
export interface TodoView {
  /** The grounds, as displayed. */
  grounds: string;
  id: number;
  text: string;
  why?: string;
  ref?: string;
  createdAt: string;
  /** Older than `[helm].todoStaleDays`. */
  stale: boolean;
}

interface TodoFile {
  nextId: number;
  items: Todo[];
}

export class TodoError extends Error {}

/** Closed items stay this long for `todo ls --all`, then go on the next write. */
const CLOSED_KEEP_MS = 30 * 24 * 3600 * 1000;
const GROUNDS_RE = /^[A-Za-z0-9._-]+$/;

export function todosRoot(): string {
  return path.join(lobstahHome(), 'todos');
}

function todosFile(grounds: string): string {
  if (!GROUNDS_RE.test(grounds) || grounds.startsWith('.')) throw new TodoError(`not a grounds name: ${grounds}`);
  return path.join(todosRoot(), `${grounds}.json`);
}

function read(grounds: string): TodoFile {
  try {
    const raw = JSON.parse(fs.readFileSync(todosFile(grounds), 'utf8')) as Partial<TodoFile>;
    const items = Array.isArray(raw.items) ? raw.items : [];
    const nextId = typeof raw.nextId === 'number' ? raw.nextId : Math.max(0, ...items.map((t) => t.id)) + 1;
    return { nextId, items };
  } catch (err) {
    if (err instanceof TodoError) throw err;
    return { nextId: 1, items: [] };
  }
}

function write(grounds: string, data: TodoFile, now: number): void {
  const file = todosFile(grounds);
  data.items = data.items.filter((t) => t.state === 'open' || now - (Date.parse(t.updatedAt) || 0) < CLOSED_KEEP_MS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  atomicRenameSync(tmp, file);
}

/** Open to-dos oldest first; `all` adds closed ones still kept. */
export function listTodos(grounds: string, opts: { all?: boolean } = {}): Todo[] {
  return read(grounds).items.filter((t) => opts.all || t.state === 'open');
}

export function addTodo(grounds: string, input: { text: string; why?: string; ref?: string }, now = Date.now()): Todo {
  const text = input.text.trim();
  if (!text) throw new TodoError('a to-do needs text');
  const data = read(grounds);
  const at = new Date(now).toISOString();
  const todo: Todo = {
    id: data.nextId,
    text,
    ...(input.why?.trim() ? { why: input.why.trim() } : {}),
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    state: 'open',
    createdAt: at,
    updatedAt: at,
  };
  data.items.push(todo);
  data.nextId += 1;
  write(grounds, data, now);
  return todo;
}

/** Mark an open to-do done or dropped. */
export function closeTodo(grounds: string, id: number, state: Exclude<TodoState, 'open'>, now = Date.now()): Todo {
  const data = read(grounds);
  const todo = data.items.find((t) => t.id === id);
  if (!todo) throw new TodoError(`no to-do ${id} — \`lobstah todo ls\` lists them`);
  if (todo.state !== 'open') throw new TodoError(`to-do ${id} is already ${todo.state}`);
  todo.state = state;
  todo.updatedAt = new Date(now).toISOString();
  write(grounds, data, now);
  return todo;
}

/** Every grounds with a to-do file, with its open to-dos. */
export function openTodosByGrounds(): Array<{ grounds: string; todos: Todo[] }> {
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
    .sort()
    .map((grounds) => ({ grounds, todos: listTodos(grounds) }))
    .filter((g) => g.todos.length > 0);
}

/** Open to-dos created more than `days` ago. `days` 0 disables. */
export function staleTodos(todos: Todo[], days: number, now = Date.now()): Todo[] {
  if (!(days > 0)) return [];
  return todos.filter((t) => t.state === 'open' && now - (Date.parse(t.createdAt) || now) > days * 24 * 3600 * 1000);
}

/** The short tend note for stale to-dos, or undefined when none are. */
export function staleTodoNote(count: number, days: number): string | undefined {
  if (count === 0) return undefined;
  const d = `${days} day${days === 1 ? '' : 's'}`;
  return `${count} to-do${count === 1 ? '' : 's'} older than ${d}: move to the issue tracker?`;
}

/** One line per to-do, for the helm's context and plain text views. */
export function todoLine(t: Todo): string {
  return `- [${t.id}] ${t.text}${t.why ? ` (why: ${t.why})` : ''}${t.ref ? ` (ref: ${t.ref})` : ''} — added ${t.createdAt.slice(0, 10)}`;
}
