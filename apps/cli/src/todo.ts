import {
  DEFAULT_HELM,
  ageLabel,
  claimHelmGoalsNudge,
  claimTodoFirings,
  displayGrounds,
  fireDueTodos,
  goalDate,
  goalLine,
  listTodos,
  loadConfig,
  overdueTodoNote,
  peekTodoFirings,
  readGoals,
  shortTodoTime,
  shownTodos,
  shownTodosByGrounds,
  staleTodoNote,
  staleTodos,
  todoFiredBy,
  todoLine,
  todoOverdue,
  todoScheduled,
  toonTable,
  toonKV,
  type Todo,
  type TodoDueEvent,
  type TodoView,
  type HelmConfig,
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
  const tz = helmTimezone();
  return todos.map((t) => ({
    grounds: display(grounds),
    groundsKey: grounds,
    id: t.id,
    text: t.text,
    createdAt: t.createdAt,
    done: t.state === 'done',
    stale: stale.has(t.id),
    ...(t.dueAt ? { dueAt: t.dueAt } : {}),
    overdue: todoOverdue(t, now),
    ...(t.state === 'open' && t.firing ? { firedBy: todoFiredBy(t.firing.cause, tz) } : {}),
    ...(t.snoozes ? { snoozes: t.snoozes } : {}),
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

/** `[helm].timezone` for todo times and the 04:00-local day boundary; absent or a config error uses the system zone. */
export function helmTimezone(): string | undefined {
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

/** The tend count line for overdue todos, or undefined. */
export function todoOverdueLine(todos: TodoView[]): string | undefined {
  return overdueTodoNote(todos.filter((t) => t.overdue).length);
}

/** Overdue first and waiting for a time last; everything else keeps its order. */
function todoRank(t: TodoView): number {
  if (t.overdue) return 0;
  return t.dueAt !== undefined && !t.done ? 2 : 1;
}

/** What a todo's `due` cell says: the time ahead, or how long ago it passed. */
function dueCell(t: TodoView, now: number): string {
  if (t.done || t.dueAt === undefined) return '';
  return t.overdue ? `overdue ${ageLabel(now - Date.parse(t.dueAt))}` : shortTodoTime(t.dueAt, now, helmTimezone());
}

/** `state`, `due` and `snoozes` columns appear only when a listed todo uses them. */
export function todoTable(todos: TodoView[], withGrounds: boolean, now = Date.now()): string {
  const anyDone = todos.some((t) => t.done);
  const anyDue = todos.some((t) => !t.done && t.dueAt !== undefined);
  const anySnoozed = todos.some((t) => t.snoozes !== undefined);
  const cols = [
    ...(withGrounds ? ['grounds'] : []),
    'id',
    ...(anyDone ? ['state'] : []),
    'text',
    ...(anyDue ? ['due'] : []),
    ...(anySnoozed ? ['snoozes'] : []),
    'added',
  ];
  const ranked = [...todos].sort((a, b) => todoRank(a) - todoRank(b));
  return toonTable(
    'todos',
    ranked.map((t) => ({
      grounds: t.grounds,
      id: t.id,
      state: t.done ? 'done' : 'open',
      text: t.text,
      due: dueCell(t, now),
      snoozes: t.snoozes ?? 0,
      added: t.createdAt.slice(0, 10),
    })),
    cols,
  );
}

/**
 * Record what has come due, then hand this grounds' undelivered firings to
 * this wake. `claim` false is `--peek`: it shows them without using them up.
 * A damaged todo file never fails a wait: the next write names the damage.
 */
export function takeTodoDue(grounds: string, claim: boolean, now = Date.now()): TodoDueEvent[] {
  fireDueTodos(now);
  const tz = helmTimezone();
  try {
    return claim ? claimTodoFirings(grounds, now, tz) : peekTodoFirings(grounds, tz);
  } catch {
    return [];
  }
}

/**
 * The daemon's `todoFiring` hook. A damaged file is logged once, not on every
 * tick, until it's fixed or a different problem replaces it.
 */
export function createTodoFiring(): (now: number, log: (message: string) => void) => void {
  let logged = new Set<string>();
  return (now, log) => {
    const { errors } = fireDueTodos(now);
    for (const error of errors) if (!logged.has(error)) log(error);
    logged = new Set(errors);
  };
}

/** The `next` line of a `todo-due` event. */
function todoDueNext(event: TodoDueEvent): string {
  return `do it, then \`lobstah todo done ${event.id}\`; \`lobstah todo snooze ${event.id} --until <time>\` to retry later; then re-arm \`lobstah man wait\`.`;
}

/** `man wait`: one `todo-due` event per firing. */
export function emitTodoDue(events: readonly TodoDueEvent[], display: (grounds: string) => string): void {
  for (const event of events) {
    console.log(toonKV({ event: 'todo-due', todo: event.id, grounds: display(event.grounds), text: event.text, firedBy: event.firedBy }));
    console.log(`next: ${todoDueNext(event)}`);
  }
}

/** The Stop hook's line for one firing. */
export function todoDueLine(event: TodoDueEvent): string {
  return `- todo-due ${event.id}: ${event.text} (${event.firedBy}). Next: ${todoDueNext(event)}`;
}

/**
 * The todo block re-injected into the helm's context at session start and
 * after compaction, beside the charter. Empty when the grounds has none.
 */
export function todoContext(grounds: string, now: number = Date.now()): string {
  let todos: Todo[];
  let helm: HelmConfig;
  try {
    todos = listTodos(grounds);
    helm = loadConfig().helm;
  } catch {
    return '';
  }
  if (todos.length === 0) return '';
  todos.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  // Overdue and scheduled todos stay named; only unscheduled todos use the brief limit.
  const overdue = todos.filter((todo) => todoOverdue(todo, now));
  const scheduled = todos.filter((todo) => todoScheduled(todo, now));
  const others = todos.filter((todo) => !todoOverdue(todo, now) && !todoScheduled(todo, now));
  const shown: Todo[] = others.slice(0, Math.max(0, helm.briefTodoLimit - overdue.length));
  const staleIds = new Set(staleTodos(todos, helm.todoStaleDays, now).map((todo) => todo.id));
  const note = staleTodoNote(staleIds.size, helm.todoStaleDays);
  const remaining: number = others.length - shown.length;
  return [
    `Your todos (\`lobstah todo done <id>\` when finished, \`lobstah todo drop <id>\` when no longer needed):`,
    'Todos are for the helm or the user, for the next few days. For anything longer, or work someone else could pick up, use your issue tracker.',
    ...overdue.map((todo) => `${todoLine(todo)} [overdue]`),
    ...shown.map((todo) => `${todoLine(todo)}${staleIds.has(todo.id) ? ' [stale]' : ''}`),
    ...(remaining > 0 ? [`… and ${remaining} more (lobstah todo ls)`] : []),
    ...scheduled.map((todo) => `${todoLine(todo)} [due ${shortTodoTime(todo.dueAt!, now, helm.timezone)}${todo.snoozes ? `; snoozed ${todo.snoozes}` : ''}]`),
    ...(note ? [note] : []),
  ].join('\n');
}

/** Today's numbered goals, re-injected only beside todos in the session-start brief. */
export function goalsContext(grounds: string, now = Date.now()): string {
  try {
    const date: string = goalDate(new Date(now), loadConfig().helm.timezone);
    const goals = readGoals(grounds, date);
    if (goals.lines.length === 0) return '';
    return [
      `Today's goals (${date}):`,
      ...goals.lines.map((line, index) => {
        const goal = goalLine(line);
        return `${index + 1}. [${goal.done ? 'x' : ' '}] ${goal.text}`;
      }),
      '`lobstah goals done <n>` as soon as one is met; `lobstah goals undo <n>` if not.',
    ].join('\n');
  } catch {
    return '';
  }
}

/** One capped goals line for a quiet timeout digest, with a per-session, per-day cooldown. */
export function quietGoalsNudge(grounds: string, sessionId: string, now = Date.now()): string | undefined {
  const helm: HelmConfig = loadConfig().helm;
  const date: string = goalDate(new Date(now), helm.timezone);
  const goals = readGoals(grounds, date).lines.map((line, index) => ({ ...goalLine(line), number: index + 1 }));
  const open = goals.filter((goal) => !goal.done);
  if (open.length === 0 || !claimHelmGoalsNudge(grounds, sessionId, date, helm.goalsNudgeSecs, now)) return undefined;
  const line = `goals ${goals.length - open.length}/${goals.length} · open: ${open.map((goal) => `${goal.number}. ${goal.text}`).join('; ')}`.replace(/\s+/g, ' ');
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/** Full open todo list for `todo ls` and helm passes, including future and snoozed items. */
export function renderTodoList(grounds: string, now: number = Date.now()): string {
  const todos = todoViews(now, grounds, { openOnly: true }).sort((a, b) => Number(b.stale) - Number(a.stale) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return todos.length > 0 ? todoTable(todos, false, now) : toonKV({ todos: 'none', grounds: displayName()(grounds) });
}
