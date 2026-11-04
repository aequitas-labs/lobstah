import { backendScopes, readHelmPass, recordHelmPass, storageGrounds, type HelmPassView, displayGrounds, goalDate, helmPassStatus, readGoals, type Config } from '@lobstah/core';
import { renderTodoList } from './todo.js';
import { renderGoals } from './goals.js';

/** Full todo/goals details when a pass is due; previewing never records delivery. */
export function helmPassNotice(grounds: string, config: Config, now = Date.now()): string | undefined {
  const status = helmPassStatus(grounds, config.helm, now);
  if (status.reasons.length === 0) return undefined;
  const name = displayGrounds(grounds, config);
  const date = goalDate(new Date(now), config.helm.timezone);
  return [
    `pass-due — ${name} (${status.reasons.join(', ')})`,
    renderTodoList(grounds, now),
    renderGoals(readGoals(grounds, date), name),
    'For each todo: do it, card it, move it to the tracker, or drop it. For each goal: check its done state and choose the next step.',
  ].join('\n');
}

/** Record a pass only after its details are emitted to the helm; no extra command or acknowledgment. */
export function deliverHelmPass(grounds: string, config: Config, emit: (details: string) => void, now = Date.now()): boolean {
  const details = helmPassNotice(grounds, config, now);
  if (!details) return false;
  emit(details);
  recordHelmPass(grounds, config.helm, undefined, now);
  return true;
}

/** Pass metadata stays visible in glass even when a grounds has no todos or goals. */
export function helmPassViews(config: Config): HelmPassView[] {
  return backendScopes(config).map((scope) => ({
    grounds: scope.grounds,
    lastPassAt: readHelmPass(storageGrounds(scope.grounds, config))?.at,
  }));
}
