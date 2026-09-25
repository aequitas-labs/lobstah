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

export function readGlassState(): GlassState | undefined {
  const file = stateFile();
  let state: GlassState;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8')) as GlassState;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return undefined;
  }
  if (!Number.isInteger(state.pid) || state.pid <= 0 || !Number.isInteger(state.port) || !pidAlive(state.pid)) {
    fs.unlinkSync(file);
    return undefined;
  }
  return state;
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

export async function startDetachedGlass(port: number): Promise<{ info: GlassInfo; already: boolean }> {
  const tracked = readGlassState();
  if (tracked && tracked.port !== port) {
    const owner = await probeGlass(tracked.port);
    if (owner?.pid === tracked.pid) {
      throw new Error(`detached glass is running on ${glassUrl(tracked.port)} — run lobstah glass stop before changing ports`);
    }
    fs.unlinkSync(stateFile());
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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    const info = await probeGlass(port);
    if (info) {
      if (info.pid === child.pid) {
        const state: GlassState = { pid: info.pid!, port, startedAt: new Date().toISOString(), version: info.version };
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n');
        return { info, already: false };
      }
      return { info, already: true }; // another starter won the port
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`glass did not answer on ${glassUrl(port)} within 5 seconds (see ${path.join(logDir, 'glass.log')})`);
}

export async function stopGlass(): Promise<{ stopped: boolean; port?: number; pid?: number }> {
  const state = readGlassState();
  if (!state) return { stopped: false };
  const info = await probeGlass(state.port);
  if (!info || info.pid !== state.pid) {
    fs.unlinkSync(stateFile());
    return { stopped: false };
  }
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await probeGlass(state.port))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await probeGlass(state.port)) throw new Error(`glass pid ${state.pid} did not stop`);
  fs.unlinkSync(stateFile());
  return { stopped: true, port: state.port, pid: state.pid };
}

export async function glassStatus(port = glassPort()): Promise<{ port: number; info?: GlassInfo; state?: GlassState }> {
  let state = readGlassState();
  const selectedPort = state?.port ?? port;
  const info = await probeGlass(selectedPort);
  if (state && info?.pid !== state.pid) {
    fs.unlinkSync(stateFile());
    state = undefined;
  }
  return { port: state || info ? selectedPort : port, info, state };
}
