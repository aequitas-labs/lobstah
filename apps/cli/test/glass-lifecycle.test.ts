import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { glassLines, glassPort, probeGlass, readGlassState, stopGlass } from '../src/glass-lifecycle.js';
import { killAndWait, reservePort, type ReservedPort } from './reserved-port.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let port: number;
let reserved: ReservedPort[];
/** Every glass pid this test saw on its ports. Teardown stops them without reading the state file. */
let started: Set<number>;

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 15_000,
  });
}

/** Like run, but leaves this process's event loop free, so an in-test server can answer the CLI. */
function runAsync(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 15_000 },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr }),
    );
  });
}

async function reserve(): Promise<number> {
  const r = await reservePort();
  reserved.push(r);
  return r.port;
}

/** Records the pid of the glass that answers on `p`, if any. The port is reserved, so it is ours. */
async function track(p: number) {
  const info = await probeGlass(p, 2000);
  if (info?.pid && info.pid !== process.pid) started.add(info.pid);
  return info;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-life-'));
  reserved = [];
  started = new Set();
  port = await reserve();
  process.env.LOBSTAH_HOME = home;
  fs.writeFileSync(path.join(home, 'config.toml'), `[glass]\nport = ${port}\n`);
});

afterEach(async () => {
  // Stop every glass this test started, pass or fail, and wait for it to exit
  // before removing the temp home: on Windows a live glass holds logs/glass.log.
  for (const r of reserved) await track(r.port);
  for (const pid of started) await killAndWait(pid);
  for (const r of reserved) r.release();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_GLASS_PORT;
});

describe('glass process lifecycle', () => {
  it('detaches, answers, reports already running, then stops and removes state', async () => {
    const first = run('glass', '--detach');
    const answering = await track(port);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`glass: http://127.0.0.1:${port}`);
    expect(first.stdout).not.toContain('already');
    const state = readGlassState();
    expect(state).toMatchObject({ port, version: expect.any(String), startedAt: expect.any(String) });
    expect(answering).toMatchObject({ pid: state?.pid });
    expect(fs.readdirSync(path.join(home, 'state')).filter((f) => f.startsWith('glass.json'))).toEqual(['glass.json']);
    expect(fs.readFileSync(path.join(home, 'logs', 'glass.log'), 'utf8')).toBeDefined();

    const second = run('glass');
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already: running');
    expect(run('glass', '--detach').stdout).toContain('already: running');
    expect(readGlassState()?.pid).toBe(state?.pid);
    expect(run('glass', 'status').stdout).toContain('glass: running');
    expect(run('doctor').stdout).toMatch(/glass.*answering/);
    const otherPort = await reserve();
    expect(run('glass', '--detach', '--port', String(otherPort)).status).not.toBe(0);
    expect(readGlassState()?.pid).toBe(state?.pid);

    const stop = run('glass', 'stop');
    expect(stop.status, stop.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, 'state', 'glass.json'))).toBe(false);
    expect(await probeGlass(port)).toBeUndefined();
  });

  it('bare man helm signs on without starting the glass', async () => {
    const helm = run('man', 'helm', '--session', 'glass-test-helm');
    expect(helm.status, helm.stderr).toBe(0);
    expect(helm.stdout).not.toContain('glass:');
    expect(await probeGlass(port)).toBeUndefined();
    expect(run('doctor').stdout).toMatch(/glass.*not answering/);
    expect(run('man', 'relieve', '--session', 'glass-test-helm').status).toBe(0);
    expect(await probeGlass(port)).toBeUndefined();
  });

  it('removes a dead-pid state file without signaling another process', () => {
    const file = path.join(home, 'state', 'glass.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 99_999_999, port, version: 'old', startedAt: new Date().toISOString() }));
    expect(run('glass', 'status').status).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('prints the stale version remedy', () => {
    expect(glassLines(port, { service: 'lobstah-glass', pid: 1, version: '0.0.0' })).toMatchObject({
      stale: '0.0.0 (run lobstah glass stop && lobstah glass --detach)',
    });
  });

  it('uses the configured port unless the environment overrides it', () => {
    expect(glassPort()).toBe(port);
    process.env.LOBSTAH_GLASS_PORT = String(port === 65535 ? port - 1 : port + 1);
    expect(glassPort()).not.toBe(port);
    delete process.env.LOBSTAH_GLASS_PORT;
  });

  it('recognizes an older glass through its read-only data endpoint', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', req.url === '/data' ? 'application/json' : 'text/html');
      res.end(req.url === '/data' ? JSON.stringify({ version: '0.4.0', dispatches: [], helms: [] }) : '<title>spyglass</title>');
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      expect(await probeGlass(port)).toMatchObject({ version: '0.4.0', service: 'lobstah-glass' });
      expect(glassLines(port, (await probeGlass(port))!, true).stale).toContain('0.4.0');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not signal a live PID when the answering glass reports a different PID', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'lobstah-glass', version: '0.5.7', pid: 1 }));
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const file = path.join(home, 'state', 'glass.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, version: '0.5.7', startedAt: new Date().toISOString() }));
    try {
      expect((await stopGlass()).stopped).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('a plain read never deletes the state file; stop and status remove a bad one', async () => {
    const file = path.join(home, 'state', 'glass.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"pid": 12');
    expect(readGlassState()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ pid: 99_999_999, port, version: 'old', startedAt: new Date().toISOString() }));
    expect(readGlassState()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
    expect((await stopGlass()).stopped).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, 'not json');
    expect(run('glass', 'status').status).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('--detach on a port another glass holds reports it, writes no state, and leaves no child behind', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'lobstah-glass', version: '0.5.7', pid: process.pid }));
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const detach = await runAsync('glass', '--detach');
      expect(detach.status, detach.stderr).toBe(0);
      expect(detach.stdout).toContain('already: running');
      expect(fs.existsSync(path.join(home, 'state', 'glass.json'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await probeGlass(port)).toBeUndefined();
  });
});
