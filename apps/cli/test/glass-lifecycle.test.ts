import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { glassLines, glassPort, probeGlass, readGlassState, stopGlass } from '../src/glass-lifecycle.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let port: number;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return selected;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 15_000,
  });
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-life-'));
  port = await freePort();
  process.env.LOBSTAH_HOME = home;
  fs.writeFileSync(path.join(home, 'config.toml'), `[glass]\nport = ${port}\n`);
});

afterEach(async () => {
  await stopGlass();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_GLASS_PORT;
});

describe('glass process lifecycle', () => {
  it('detaches, answers, reports already running, then stops and removes state', async () => {
    const first = run('glass', '--detach');
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`glass: http://127.0.0.1:${port}`);
    const state = readGlassState();
    expect(state).toMatchObject({ port, version: expect.any(String), startedAt: expect.any(String) });
    expect(await probeGlass(port)).toMatchObject({ pid: state?.pid });
    expect(fs.readFileSync(path.join(home, 'logs', 'glass.log'), 'utf8')).toBeDefined();

    const second = run('glass');
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already: running');
    expect(run('glass', '--detach').stdout).toContain('already: running');
    expect(readGlassState()?.pid).toBe(state?.pid);
    expect(run('glass', 'status').stdout).toContain('glass: running');
    expect(run('doctor').stdout).toMatch(/glass.*answering/);
    const otherPort = await freePort();
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
});
