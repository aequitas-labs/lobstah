import {
  DEFAULT_HELM,
  displayGrounds,
  listTodos,
  loadConfig,
  openTodosByGrounds,
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

/** Open todos, every grounds or one, oldest first within each grounds. */
export function todoViews(now = Date.now(), grounds?: string): TodoView[] {
  const days = todoStaleDays();
  const display = displayName();
  if (grounds !== undefined) return view(grounds, listTodos(grounds), days, now, display);
  return openTodosByGrounds().flatMap((g) => view(g.grounds, g.todos, days, now, display));
}

/** The tend note for stale todos, or undefined. */
export function todoStaleLine(todos: TodoView[]): string | undefined {
  return staleTodoNote(todos.filter((t) => t.stale).length, todoStaleDays());
}

export function todoTable(todos: TodoView[], withGrounds: boolean): string {
  const cols = [...(withGrounds ? ['grounds'] : []), 'id', 'text', 'added'];
  return toonTable(
    'todos',
    todos.map((t) => ({ grounds: t.grounds, id: t.id, text: t.text, added: t.createdAt.slice(0, 10) })),
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
