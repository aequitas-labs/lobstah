import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { laneDirs, worktreeLockFile } from '@lobstah/core';
import { stopChildren } from '../../../test/child-process.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { windowsCommand } from '../src/heavy.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const unix = process.platform !== 'win32';
const TEST_MS = 60_000;

let home: string;
let priorHome: string | undefined;
const children: ChildProcess[] = [];

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home, ...extra };
  delete out.CLAUDE_CODE_SESSION_ID;
  delete out.LOBSTAH_HEAVY_TICKET;
  for (const k of ['VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) delete out[k];
  return { ...out, ...extra };
}

/** Start `lobstah heavy -- node -e <script>`. */
function start(script: string, extra: NodeJS.ProcessEnv = {}): { child: ChildProcess; output: () => string; done: Promise<number | null> } {
  const child = spawn(process.execPath, [cli, 'heavy', '--', process.execPath, '-e', script], { env: env(extra), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (out += String(d)));
  const done = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, output: () => out, done };
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const tickets = () => {
  const dir = path.join(home, 'heavy', 'line');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { seq: number; state: string; pid: number; group?: number })
    : [];
};
const setSlots = (n: number) => fs.writeFileSync(path.join(home, 'config.toml'), `[heavy]\nslots = ${n}\n`);
const sleeper = (ms: number, file?: string) => `${file ? `require('fs').writeFileSync(${JSON.stringify(file)},'');` : ''}setTimeout(()=>{},${ms})`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-cli-'));
  priorHome = process.env.LOBSTAH_HOME;
  process.env.LOBSTAH_HOME = home;
});
afterEach(async () => {
  await stopChildren(children.splice(0));
  for (const t of tickets()) {
    if (t.group) {
      try {
        process.kill(-t.group, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  if (priorHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = priorHome;
  removeTempDir(home);
});

describe('starting a command on Windows', () => {
  it('runs an .exe directly, whatever its path holds', () => {
    expect(windowsCommand(['C:\\Program Files\\node.exe', '-e', "a('b')"], 'win32')).toEqual(['C:\\Program Files\\node.exe', ['-e', "a('b')"], false]);
  });

  it('quotes what the shell would split or mangle', () => {
    expect(windowsCommand(['npx', 'vitest', 'run', 'a b.ts', 'say "hi"'], 'win32')).toEqual(['npx', ['vitest', 'run', '"a b.ts"', '"say \\"hi\\""'], true]);
  });

  it('uses no shell elsewhere', () => {
    expect(windowsCommand(['npx', 'a b'], 'linux')).toEqual(['npx', ['a b'], false]);
  });
});

describe('lobstah heavy', () => {
  it('passes through the exit code, gives the worker limits, and shows an empty line', () => {
    setSlots(1);
    const run = spawnSync(process.execPath, [cli, 'heavy', '--', process.execPath, '-e', "console.log(process.env.VITEST_MAX_FORKS, process.env.VITEST_MAX_THREADS, process.env.VITEST_MAX_WORKERS, Boolean(process.env.LOBSTAH_HEAVY_TICKET)); process.exit(7)"], { env: env(), cwd: home, encoding: 'utf8' });
    expect(run.status).toBe(7);
    const n = Math.max(2, Math.floor(os.availableParallelism() / 3));
    expect(run.stdout.trim()).toBe(`${n} ${n} ${n} true`);
    expect(run.stderr).toContain('heavy: running, slot 1 of 1');
    expect(tickets()).toEqual([]);
    const view = spawnSync(process.execPath, [cli, 'heavy'], { env: env(), cwd: home, encoding: 'utf8' });
    expect(view.stdout).toMatch(/^heavy: 0 of 1 running · 0 waiting · load \d+/);
  }, TEST_MS);

  it('never runs more than the limit, and every parallel start runs', async () => {
    setSlots(2);
    const log = path.join(home, 'log');
    const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'+\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'-\\n')},300)`;
    const runs = Array.from({ length: 6 }, () => start(script));
    const codes = await Promise.all(runs.map((r) => r.done));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(events.filter((e) => e === '+')).toHaveLength(6);
    let at = 0;
    let peak = 0;
    for (const e of events) {
      at += e === '+' ? 1 : -1;
      peak = Math.max(peak, at);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(tickets()).toEqual([]);
  }, TEST_MS);

  it('a nested heavy takes no second slot', () => {
    setSlots(1);
    const run = spawnSync(process.execPath, [cli, 'heavy', '--', process.execPath, cli, 'heavy', '--', process.execPath, '-e', "console.log('inner')"], { env: env(), cwd: home, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('inner');
    expect(run.stderr.match(/running, slot/g)).toHaveLength(1);
  }, TEST_MS);

  it('runs the command without a slot when the line fails, and says so once', () => {
    fs.writeFileSync(path.join(home, 'heavy'), 'in the way');
    const run = spawnSync(process.execPath, [cli, 'heavy', '--', process.execPath, '-e', "console.log('ran'); process.exit(3)"], { env: env(), cwd: home, encoding: 'utf8' });
    expect(run.status).toBe(3);
    expect(run.stdout.trim()).toBe('ran');
    expect(run.stderr.trim().split('\n')).toEqual([expect.stringContaining('running without a slot')]);
  }, TEST_MS);

  it('a command that cannot start fails as 127 and frees its slot', () => {
    const run = spawnSync(process.execPath, [cli, 'heavy', '--', 'no-such-command-for-heavy-test'], { env: env(), cwd: home, encoding: 'utf8' });
    expect(run.status).toBe(unix ? 127 : run.status);
    expect(tickets()).toEqual([]);
  }, TEST_MS);

  it('man tend shows the line while anything is in it, and only then', async () => {
    setSlots(1);
    const tend = () => spawnSync(process.execPath, [cli, 'man', 'tend'], { env: env(), cwd: home, encoding: 'utf8' }).stdout;
    expect(tend()).not.toContain('heavy:');
    const holding = path.join(home, 'holding');
    const release = path.join(home, 'release');
    const first = start(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(holding)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},50)`);
    await until(() => fs.existsSync(holding));
    expect(tend()).toMatch(/heavy: 1 of 1 running · 0 waiting/);
    fs.writeFileSync(release, '');
    expect(await first.done).toBe(0);
    expect(tend()).not.toContain('heavy:');
  }, TEST_MS);

  it('a cancelled waiter exits having run nothing', async () => {
    setSlots(1);
    const marker = path.join(home, 'ran');
    const holding = path.join(home, 'holding');
    const first = start(sleeper(30_000, holding));
    await until(() => fs.existsSync(holding));
    const waiter = start(`require('fs').writeFileSync(${JSON.stringify(marker)},'')`);
    await until(() => tickets().length === 2);
    const line = path.join(home, 'heavy', 'line');
    const [name] = fs.readdirSync(line).filter((f) => f.endsWith('.json')).sort().slice(-1);
    const ticket = JSON.parse(fs.readFileSync(path.join(line, name!), 'utf8'));
    fs.writeFileSync(path.join(line, name!), JSON.stringify({ ...ticket, state: 'cancelled', reason: 'trap stowed' }));
    expect(await waiter.done).toBe(75);
    expect(waiter.output()).toContain('trap stowed');
    expect(fs.existsSync(marker)).toBe(false);
    first.child.kill('SIGTERM');
    await first.done;
  }, TEST_MS);

  describe.skipIf(!unix)('with processes killed', () => {
    it('kill -9 of a holder keeps the slot until its command ends', async () => {
      setSlots(1);
      const holding = path.join(home, 'holding');
      const first = start(sleeper(3000, holding));
      await until(() => fs.existsSync(holding));
      await until(() => tickets()[0]?.group !== undefined);
      const nextRan = path.join(home, 'next');
      const next = start(`require('fs').writeFileSync(${JSON.stringify(nextRan)},'')`);
      first.child.kill('SIGKILL');
      await first.done;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // The wrapper is gone but its command still runs, so the load is real.
      expect(fs.existsSync(nextRan)).toBe(false);
      expect(await next.done).toBe(0);
      expect(fs.existsSync(nextRan)).toBe(true);
    }, TEST_MS);

    it('kill -9 of a waiter lets the next one by, and a retry from that session takes its place back', async () => {
      setSlots(1);
      const holding = path.join(home, 'holding');
      const first = start(sleeper(30_000, holding));
      await until(() => fs.existsSync(holding));
      const killed = start(sleeper(0), { CLAUDE_CODE_SESSION_ID: 'retry-session' });
      await until(() => tickets().length === 2);
      const killedSeq = Math.max(...tickets().map((t) => t.seq));
      const later = start(sleeper(0), { CLAUDE_CODE_SESSION_ID: 'other-session' });
      await until(() => tickets().length === 3);
      killed.child.kill('SIGKILL');
      await killed.done;
      const retry = start(sleeper(0), { CLAUDE_CODE_SESSION_ID: 'retry-session' });
      await until(() => tickets().find((t) => t.seq === killedSeq)?.pid === retry.child.pid);
      expect(tickets().map((t) => t.seq).sort((a, b) => a - b)).toHaveLength(3);
      first.child.kill('SIGTERM');
      await first.done;
      expect(await retry.done).toBe(0);
      expect(await later.done).toBe(0);
    }, TEST_MS);

    it('passes SIGTERM on to the command and reports its death', async () => {
      setSlots(1);
      const holding = path.join(home, 'holding');
      const first = start(sleeper(30_000, holding));
      await until(() => fs.existsSync(holding));
      first.child.kill('SIGTERM');
      expect(await first.done).toBe(143);
      await until(() => tickets().length === 0);
    }, TEST_MS);
  });

  it('--bg returns at once and posts the exit code, log and last lines to the dispatch', async () => {
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt);
    expect(spawnSync('git', ['init', '-q', wt]).status).toBe(0);
    const id = 'heavy-bg-dispatch';
    const active = path.join(laneDirs('work').active, id);
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'descriptor.json'), JSON.stringify({ id, repo: 'r', prompt: 'x' }));
    fs.writeFileSync(worktreeLockFile(wt)!, JSON.stringify({ id, lane: 'work', pid: process.pid, at: new Date().toISOString() }));

    const started = Date.now();
    const run = spawnSync(process.execPath, [cli, 'heavy', '--bg', '--', process.execPath, '-e', "console.log('the last line'); setTimeout(()=>process.exit(4),1500)"], { env: env(), cwd: wt, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500 + 5000);
    expect(run.stdout).toContain('in the background');

    const inbox = () => spawnSync(process.execPath, [cli, 'inbox', id], { env: env(), cwd: wt, encoding: 'utf8' }).stdout;
    let text = '';
    await until(() => {
      text = inbox();
      return text.includes('exited 4');
    });
    expect(text).toContain('the last line');
    expect(text).toMatch(/log: .*\.log/);
    await until(() => tickets().length === 0);
  }, TEST_MS);
});
