import {
  DEFAULT_HELM,
  displayGrounds,
  listTodos,
  loadConfig,
  shownTodos,
  shownTodosByGrounds,
  staleTodoNote,
  staleTodos,
  todoLine,
  toonTable,
  type Todo,
  type TodoView,
} from '@lobstah/core';

export type { TodoView };

/** `[helm].todoStaleDays`; a config error falls back to the default. */
export function todoStaleDays(): number {
  try {
    return loadConfig().helm.todoStaleDays;
  } catch {
    return DEFAULT_HELM.todoStaleDays;
  }
}

function view(grounds: string, todos: Todo[], days: number, now: number, display: (g: string) => string): TodoView[] {
  const stale = new Set(staleTodos(todos, days, now).map((t) => t.id));
  return todos.map((t) => ({
    grounds: display(grounds),
    id: t.id,
    text: t.text,
    createdAt: t.createdAt,
    done: t.state === 'done',
    stale: stale.has(t.id),
  }));
}

function displayName(): (g: string) => string {
  try {
    const cfg = loadConfig();
    return (g) => displayGrounds(g, cfg);
  } catch {
    return (g) => g;
  }
}

/** `[helm].timezone` for the 04:00-local day boundary; absent or a config error uses the system zone. */
function helmTimezone(): string | undefined {
  try {
    return loadConfig().helm.timezone;
  } catch {
    return undefined;
  }
}

/**
 * Todos as tend and the glass show them, every grounds or one, oldest first
 * within each grounds: the open ones, plus those done since today's 04:00
 * boundary, which stay checked until the day rolls over. `openOnly` (with
 * one grounds, for `todo ls`) keeps just the open ones.
 */
export function todoViews(now = Date.now(), grounds?: string, opts: { openOnly?: boolean } = {}): TodoView[] {
  const days = todoStaleDays();
  const display = displayName();
  const tz = helmTimezone();
  if (grounds !== undefined) return view(grounds, opts.openOnly ? listTodos(grounds) : shownTodos(grounds, now, tz), days, now, display);
  return shownTodosByGrounds(now, tz).flatMap((g) => view(g.grounds, g.todos, days, now, display));
}

/** The tend note for stale todos, or undefined. */
export function todoStaleLine(todos: TodoView[]): string | undefined {
  return staleTodoNote(todos.filter((t) => t.stale).length, todoStaleDays());
}

/** A `state` column (open or done) appears only when a done-today todo is listed. */
export function todoTable(todos: TodoView[], withGrounds: boolean): string {
  const anyDone = todos.some((t) => t.done);
  const cols = [...(withGrounds ? ['grounds'] : []), 'id', ...(anyDone ? ['state'] : []), 'text', 'added'];
  return toonTable(
    'todos',
    todos.map((t) => ({ grounds: t.grounds, id: t.id, state: t.done ? 'done' : 'open', text: t.text, added: t.createdAt.slice(0, 10) })),
    cols,
  );
}

/**
 * The todo block re-injected into the helm's context at session start and
 * after compaction, beside the charter. Empty when the grounds has none.
 */
export function todoContext(grounds: string, now = Date.now()): string {
  let todos: Todo[];
  try {
    todos = listTodos(grounds);
  } catch {
    return '';
  }
  if (todos.length === 0) return '';
  const note = staleTodoNote(staleTodos(todos, todoStaleDays(), now).length, todoStaleDays());
  return [
    `Your todos (\`lobstah todo done <id>\` when finished, \`lobstah todo drop <id>\` when no longer needed):`,
    ...todos.map(todoLine),
    ...(note ? [note] : []),
  ].join('\n');
}
