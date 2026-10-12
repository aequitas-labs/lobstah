import fs from 'node:fs';
import path from 'node:path';
import { lobstahHome } from './paths.js';

/** A foreground wait whose harness delivers its completion to this session. */
export interface SessionWatcher {
  sessionId: string;
  kind: 'man' | 'trap';
  pid: number;
  heartbeatAt: string;
  trapId?: string;
}

export function readSessionWatcher(sessionId: string, now = Date.now()): SessionWatcher | undefined {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(lobstahHome(), 'watchers', `${encodeURIComponent(sessionId)}.json`), 'utf8')) as SessionWatcher;
    const beat = Date.parse(w.heartbeatAt);
    if (w.sessionId !== sessionId || !Number.isInteger(w.pid) || w.pid <= 0 || !Number.isFinite(beat) || now - beat > 5_000) return undefined;
    return w;
  } catch { return undefined; }
}
