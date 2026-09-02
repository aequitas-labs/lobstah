import * as fs from 'node:fs';
import type { Lane, NormalizedEvent } from './types.js';
import { eventsPath } from './paths.js';

export function appendEvent(id: string, lane: Lane, ev: NormalizedEvent): void {
  fs.appendFileSync(eventsPath(id, lane), `${JSON.stringify(ev)}\n`);
}

/** Millisecond timestamp of the last event, from file mtime. Undefined when absent. */
export function lastEventAt(id: string, lane: Lane): number | undefined {
  try {
    return fs.statSync(eventsPath(id, lane)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function readEvents(id: string, lane: Lane): NormalizedEvent[] {
  try {
    return fs
      .readFileSync(eventsPath(id, lane), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as NormalizedEvent);
  } catch {
    return [];
  }
}
