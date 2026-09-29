import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { COMPILED_BINARY, loadConfig, lobstahHome, lobstahVersion } from '@lobstah/core';

export interface GlassInfo {
  service: 'lobstah-glass';
  version: string;
  pid?: number;
}

export interface GlassState {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export const glassUrl = (port: number): string => `http://127.0.0.1:${port}`;
const stateFile = (): string => path.join(lobstahHome(), 'state', 'glass.json');

export function glassPort(): number {
  const value = Number(process.env.LOBSTAH_GLASS_PORT ?? loadConfig().glass.port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('glass port must be an integer from 1 to 65535');
  return value;
}

function readStateText(): string | undefined {
  try {
    return fs.readFileSync(stateFile(), 'utf8');
  } catch {
    return undefined;
  }
}

/** The state in `text` when it parses, is well formed, and names a live pid. */
function liveState(text: string | undefined): GlassState | undefined {
  if (text === undefined) return undefined;
  let state: GlassState;
  try {
    state = JSON.parse(text) as GlassState;
  } catch {
    return undefined;
  }
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0 || !Number.isInteger(state.port)) return undefined;
  return pidAlive(state.pid) ? state : undefined;
}

/**
 * The detached glass's state, or undefined when there is no file, it does not
 * parse, or its pid is dead. A plain read never deletes the file: one bad read
 * must not destroy state for every reader after it. Deletion belongs to stop,
 * status, and --detach, which own the lifecycle (see pruneGlassState).
 */
export function readGlassState(): GlassState | undefined {
  return liveState(readStateText());
}

/**
 * The read that stop, status, and --detach use. It deletes a state file that
 * is bad on two reads, 50 ms apart, so a file that a starter is replacing at
 * that moment survives.
 */
async function pruneGlassState(): Promise<GlassState | undefined> {
  if (readStateText() === undefined) return undefined;
  const first = readGlassState();
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = readGlassState();
  if (!second) removeGlassState();
  return second;
}

/** Writes the state to a temp file, then renames it over the state file, so a reader never sees a partial file. */
function writeGlassState(state: GlassState): void {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function removeGlassState(): void {
  fs.rmSync(stateFile(), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The version endpoint proves that the occupant is a lobstah glass. */
function probeVersionEndpoint(port: number, timeoutMs: number): Promise<GlassInfo | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info?: GlassInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const req = http.get(`${glassUrl(port)}/api/version`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024) {
          finish();
          req.destroy();
        }
      });
      res.on('close', () => finish());
      res.on('end', () => {
        try {
          const info = JSON.parse(body) as GlassInfo;
          finish(info.service === 'lobstah-glass' && Number.isInteger(info.pid) && typeof info.version === 'string' ? info : undefined);
        } catch {
          finish();
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish());
  });
}

/** Older glasses expose their version in /data but not /api/version. */
function probeLegacyGlass(port: number, timeoutMs: number): Promise<GlassInfo | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info?: GlassInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const req = http.get(`${glassUrl(port)}/data`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) {
          finish();
          req.destroy();
        }
      });
      res.on('close', () => finish());
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { version?: unknown; dispatches?: unknown; helms?: unknown };
          finish(
            typeof data.version === 'string' && Array.isArray(data.dispatches) && Array.isArray(data.helms)
              ? { service: 'lobstah-glass', version: data.version }
              : undefined,
          );
        } catch {
          finish();
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish());
  });
}

export async function probeGlass(port: number, timeoutMs = 400): Promise<GlassInfo | undefined> {
  return (await probeVersionEndpoint(port, timeoutMs)) ?? (await probeLegacyGlass(port, timeoutMs));
}

export function glassLines(port: number, info: GlassInfo, already = false): Record<string, string> {
  return {
    glass: glassUrl(port),
    ...(already ? { already: 'running' } : {}),
    ...(info.version !== lobstahVersion() ? { stale: `${info.version} (run lobstah glass stop && lobstah glass --detach)` } : {}),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signals `pid` and waits until it has exited. True when it is gone. */
async function terminate(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // it has already exited
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

/**
 * Starts a detached glass on `port`. It reports success only when the port
 * answers, the state file is on disk, and the answering pid equals the recorded
 * pid. On every other outcome, the child it spawned does not outlive it.
 */
export async function startDetachedGlass(port: number): Promise<{ info: GlassInfo; already: boolean }> {
  const tracked = await pruneGlassState();
  if (tracked && tracked.port !== port) {
    const owner = await probeGlass(tracked.port);
    if (owner?.pid === tracked.pid) {
      throw new Error(`detached glass is running on ${glassUrl(tracked.port)} — run lobstah glass stop before changing ports`);
    }
    removeGlassState();
  }
  const existing = await probeGlass(port);
  if (existing) return { info: existing, already: true };

  const home = lobstahHome();
  const logDir = path.join(home, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, 'glass.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [...(COMPILED_BINARY ? [] : [fs.realpathSync(process.argv[1]!)]), 'glass', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  let childError: Error | undefined;
  child.on('error', (error) => {
    childError = error;
  });
  child.unref();
  let started = false;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      const info = await probeGlass(port);
      if (info) {
        // Another glass holds the port. Ours cannot bind it and is stopped below.
        if (info.pid !== child.pid) return { info, already: true };
        writeGlassState({ pid: info.pid!, port, startedAt: new Date().toISOString(), version: info.version });
        const recorded = readGlassState();
        const answering = await probeGlass(port);
        if (!recorded || recorded.pid !== info.pid || answering?.pid !== recorded.pid) {
          throw new Error(`glass on ${glassUrl(port)} did not match its state file (see ${path.join(logDir, 'glass.log')})`);
        }
        started = true;
        return { info, already: false };
      }
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`glass did not answer on ${glassUrl(port)} within 5 seconds (see ${path.join(logDir, 'glass.log')})`);
  } finally {
    if (!started && child.pid !== undefined) {
      await terminate(child.pid, 5000);
      if (readGlassState()?.pid === child.pid) removeGlassState();
    }
  }
}

export async function stopGlass(): Promise<{ stopped: boolean; port?: number; pid?: number }> {
  const state = await pruneGlassState();
  if (!state) return { stopped: false };
  // A slow glass may miss one probe; do not forget a live glass on a single miss.
  const info = (await probeGlass(state.port)) ?? (await probeGlass(state.port, 2000));
  if (!info || info.pid !== state.pid) {
    removeGlassState();
    return { stopped: false };
  }
  if (!(await terminate(state.pid, 5000))) throw new Error(`glass pid ${state.pid} did not stop`);
  removeGlassState();
  return { stopped: true, port: state.port, pid: state.pid };
}

export async function glassStatus(port = glassPort()): Promise<{ port: number; info?: GlassInfo; state?: GlassState }> {
  let state = await pruneGlassState();
  const selectedPort = state?.port ?? port;
  const info = (await probeGlass(selectedPort)) ?? (state ? await probeGlass(selectedPort, 2000) : undefined);
  if (state && info?.pid !== state.pid) {
    removeGlassState();
    state = undefined;
  }
  return { port: state || info ? selectedPort : port, info, state };
}
