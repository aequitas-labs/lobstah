import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Lane } from './types.js';

export function lobstahHome(): string {
  return process.env.LOBSTAH_HOME ?? path.join(os.homedir(), '.lobstah');
}

export function laneRoot(lane: Lane): string {
  return lane === 'work' ? lobstahHome() : path.join(lobstahHome(), 'chores');
}

export interface LaneDirs {
  queue: string;
  active: string;
  done: string;
  state: string;
  inbox: string;
}

export function laneDirs(lane: Lane): LaneDirs {
  const root = laneRoot(lane);
  return {
    queue: path.join(root, 'queue'),
    active: path.join(root, 'active'),
    done: path.join(root, 'done'),
    state: path.join(root, 'state'),
    inbox: path.join(root, 'inbox'),
  };
}

export function ensureLayout(): void {
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const dir of Object.values(laneDirs(lane))) fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(lobstahHome(), 'worktrees'), { recursive: true });
}

export function statusPath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, `${id}.status`);
}
export function eventsPath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, `${id}.events`);
}
export function evidencePath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, `${id}.evidence`);
}
export function executorPath(): string {
  return path.join(lobstahHome(), 'executor.json');
}
