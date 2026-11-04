import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HelmConfig } from './config.js';
import { goalDate, goalsFile } from './goals.js';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { listTodos, staleTodos, type Todo } from './todos.js';

/** A delivered todo/goals pass belongs to the grounds, surviving helm restarts and takeovers. */
export interface HelmPass {
  at: string;
  note?: string;
  /** Stale todo versions reviewed by this pass; unchanged ones do not immediately re-stand it. */
  reviewedTodos: Array<{ id: number; updatedAt: string }>;
}

/** Per-grounds pass age shown beside goals and todos, including empty lists. */
export interface HelmPassView {
  grounds: string;
  lastPassAt?: string;
}

export type HelmPassReason = 'daily' | 'interval' | 'stale-todos';

/** Current standing pass requirement; reading it never acknowledges it. */
export interface HelmPassStatus {
  lastPass?: HelmPass;
  reasons: HelmPassReason[];
  staleTodos: Todo[];
}

function helmPassFile(grounds: string): string {
  // Use the same grounds validation as the daily goals store.
  goalsFile(grounds, '2000-01-01');
  return path.join(lobstahHome(), 'passes', `${grounds}.json`);
}

/** Last completed pass, or none for an absent or invalid record. */
export function readHelmPass(grounds: string): HelmPass | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(helmPassFile(grounds), 'utf8')) as HelmPass;
    if (!Number.isFinite(Date.parse(record.at)) || !Array.isArray(record.reviewedTodos)) return undefined;
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Daily boundary matches goals (04:00 local); zero interval disables only the periodic condition. */
export function helmPassStatus(grounds: string, config: HelmConfig, now = Date.now()): HelmPassStatus {
  const lastPass = readHelmPass(grounds);
  const stale = staleTodos(listTodos(grounds), config.todoStaleDays, now);
  const reasons: HelmPassReason[] = [];
  if (!lastPass || goalDate(new Date(lastPass.at), config.timezone) !== goalDate(new Date(now), config.timezone)) reasons.push('daily');
  if (lastPass && config.passIntervalSecs > 0 && now - Date.parse(lastPass.at) >= config.passIntervalSecs * 1000) reasons.push('interval');
  if (stale.some((todo) => !lastPass?.reviewedTodos.some((reviewed) => reviewed.id === todo.id && reviewed.updatedAt === todo.updatedAt))) reasons.push('stale-todos');
  return { lastPass, reasons, staleTodos: stale };
}

/** Record delivery of the pass, acknowledging current stale versions without changing any todo or goal. */
export function recordHelmPass(grounds: string, config: HelmConfig, note?: string, now = Date.now()): HelmPass {
  const record: HelmPass = {
    at: new Date(now).toISOString(),
    ...(note ? { note } : {}),
    reviewedTodos: staleTodos(listTodos(grounds), config.todoStaleDays, now).map(({ id, updatedAt }) => ({ id, updatedAt })),
  };
  const file = helmPassFile(grounds);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = uniqueTempPath(file);
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  atomicRenameSync(temporary, file);
  return record;
}
