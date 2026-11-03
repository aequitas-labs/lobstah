import { backendScopes, readHelmPass, storageGrounds, type HelmPassView, displayGrounds, goalDate, goalLine, helmPassStatus, readGoals, readHelm, type Config } from '@lobstah/core';
import { goalsContext, todoTable, todoViews } from './todo.js';

/** A level-triggered reminder: only `man pass` acknowledges it, never a wait or Stop hook. */
export function helmPassNotice(grounds: string, config: Config, now = Date.now()): string | undefined {
  const status = helmPassStatus(grounds, config.helm, now);
  if (status.reasons.length === 0) return undefined;
  const name = displayGrounds(grounds, config);
  const session = readHelm(grounds)?.sessionId;
  const date = goalDate(new Date(now), config.helm.timezone);
  const openGoals = readGoals(grounds, date).lines.map((line, index) => ({ ...goalLine(line), number: index + 1 })).filter((goal) => !goal.done);
  return [
    `pass-due — ${name} (${status.reasons.join(', ')})`,
    ...status.staleTodos.map((todo) => `- stale todo ${todo.id}: ${todo.text}`),
    ...openGoals.map((goal) => `- open goal ${goal.number}: ${goal.text}`),
    `Run \`lobstah man pass --grounds ${name}${session ? ` --session ${session}` : ''}\`. For each todo: do it, card it, move it to the tracker, or drop it. Check whether each goal is met and choose its next step.`,
  ].join('\n');
}

/** The full pass list, including done-today todos and every goal's done state, stale todos first. */
export function renderHelmPass(grounds: string, now = Date.now()): string {
  const todos = todoViews(now, grounds).sort((a, b) => Number(b.stale) - Number(a.stale) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return [
    todos.length ? todoTable(todos, false) : 'Todos: none',
    goalsContext(grounds, now) || "Today's goals: none set",
    'For each todo: do it, card it, move it to the tracker, or drop it. For each goal: check its done state and choose the next step.',
  ].join('\n');
}

/** Pass metadata stays visible in glass even when a grounds has no todos or goals. */
export function helmPassViews(config: Config): HelmPassView[] {
  return backendScopes(config).map((scope) => ({
    grounds: scope.grounds,
    lastPassAt: readHelmPass(storageGrounds(scope.grounds, config))?.at,
  }));
}
