import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from '@lobstah/core';

/** A foreground wait whose completion notification wakes its harness session. */
export interface SessionWatcher {
  sessionId: string;
  kind: 'man' | 'trap';
  pid: number;
  heartbeatAt: string;
  trapId?: string;
}

const STALE_MS = 5_000;
const HEARTBEAT_MS = 1_500;
const watcherDir = () => path.join(lobstahHome(), 'watchers');
const watcherFile = (sessionId: string) => path.join(watcherDir(), `${encodeURIComponent(sessionId)}.json`);

function liveRegistration(sessionId: string, now = Date.now()): SessionWatcher | undefined {
  try {
    const w = JSON.parse(fs.readFileSync(watcherFile(sessionId), 'utf8')) as SessionWatcher;
    const beat = Date.parse(w.heartbeatAt);
    if (w.sessionId !== sessionId || !Number.isInteger(w.pid) || w.pid <= 0 || !Number.isFinite(beat) || now - beat > STALE_MS) return undefined;
    return w;
  } catch {
    return undefined;
  }
}

export function liveWatcher(sessionId: string, kind: SessionWatcher['kind'], trapId?: string, now = Date.now()): SessionWatcher | undefined {
  const w = liveRegistration(sessionId, now);
  return w?.kind === kind && (!trapId || w.trapId === trapId) ? w : undefined;
}

/**
 * Poll up to graceMs for a live watcher. `man wait` launched as a background
 * task right before the turn ends races the Stop hook: the node process may
 * not have written its registration yet. A stale registration gets the same
 * window, since a watcher that just timed out is likely being re-armed.
 */
export async function awaitWatcher(
  sessionId: string, kind: SessionWatcher['kind'], graceMs: number, trapId?: string, pollMs = 100,
): Promise<SessionWatcher | undefined> {
  const deadline = Date.now() + Math.max(0, graceMs);
  for (;;) {
    const w = liveWatcher(sessionId, kind, trapId);
    if (w || Date.now() >= deadline) return w;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** One watcher per session. The file is an atomic claim, heartbeated until exit. */
export function armWatcher(sessionId: string, kind: SessionWatcher['kind'], trapId?: string): { stop: () => void } {
  fs.mkdirSync(watcherDir(), { recursive: true });
  const file = watcherFile(sessionId);
  const own = (): SessionWatcher => ({ sessionId, kind, pid: process.pid, heartbeatAt: new Date().toISOString(), ...(trapId ? { trapId } : {}) });
  let claimed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(own())}\n`, { flag: 'wx' });
      claimed = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const live = liveRegistration(sessionId);
      if (live) throw new Error(`watcher already armed for session ${sessionId} (pid ${live.pid})`);
      // A stale watcher cannot keep the session unarmed forever.
      try { fs.rmSync(file); } catch { /* a concurrent owner may have moved it */ }
    }
  }
  if (!claimed) throw new Error(`could not arm watcher for session ${sessionId}`);
  const ownsFile = () => {
    try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as SessionWatcher).pid === process.pid; }
    catch { return false; }
  };
  const beat = () => {
    if (!ownsFile()) return;
    const tmp = `${file}.tmp-${process.pid}`;
    try { fs.writeFileSync(tmp, `${JSON.stringify(own())}\n`); fs.renameSync(tmp, file); }
    catch { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
  };
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (ownsFile()) fs.rmSync(file, { force: true });
    process.off('exit', stop);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
  const interrupt = () => { stop(); process.exit(130); };
  const terminate = () => { stop(); process.exit(143); };
  process.on('exit', stop);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  return { stop };
}
