import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, addTodo, ensureLayout, goalDate, helmPassStatus, loadConfig, readHelmPass, recordHelmPass, setGoals, snoozeTodo, takeHelm } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { deliverHelmPass, helmPassNotice } from '../src/helm-pass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'pass-helm';
let home: string;
const environment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX'))),
  LOBSTAH_HOME: home,
});
const run = (args: string[], hook?: Record<string, unknown>) => spawnSync(process.execPath, [cli, ...args], {
  cwd: home, env: environment(), encoding: 'utf8', timeout: 10000,
  input: hook ? JSON.stringify({ cwd: home, ...hook }) : undefined,
});
const seat = (harness: 'claude' | 'codex' = 'claude'): void => {
  takeHelm({ sessionId: session, grounds: { name: 'fleet', repos: [] }, ttlMs: 60000, identity: { harness } });
};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-pass-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "UTC"\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('sign-on delivers the full due pass without a new command or charter rule', () => {
  addTodo('fleet', 'Check the release');
  setGoals('fleet', goalDate(new Date(), 'UTC'), ['[x] Shipped']);
  const result = run(['man', 'helm', '--session', session]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^pass-due/);
  expect(result.stdout).toContain('Check the release');
  expect(result.stdout).toContain('1. [x] Shipped');
  expect(result.stdout).not.toContain('man pass');
  expect(readHelmPass('fleet')).toBeDefined();
  expect(run(['man', 'pass', '--session', session]).status).not.toBe(0);
});

for (const harness of ['claude', 'codex'] as const) {
  it(`${harness}: Stop delivers stale-first todos and all goal states once, even with a live watcher`, () => {
    seat(harness);
    const now = Date.now();
    addTodo('fleet', 'Newer todo', now);
    addTodo('fleet', 'Stale reminder', now - 4 * 86400000);
    setGoals('fleet', goalDate(new Date(), 'UTC'), ['[x] Closed goal', 'Open goal']);
    fs.writeFileSync(path.join(home, 'watchers', `${session}.json`), JSON.stringify({ sessionId: session, kind: 'man', pid: process.pid, heartbeatAt: new Date().toISOString() }));
    const result = run(['hook', 'stop'], { session_id: session });
    expect(result.status, result.stderr).toBe(0);
    const stopped = JSON.parse(result.stdout);
    expect(stopped.decision).toBe('block');
    expect(stopped.reason).toMatch(/^pass-due/);
    expect(stopped.reason.indexOf('Stale reminder')).toBeLessThan(stopped.reason.indexOf('Newer todo'));
    expect(stopped.reason).toContain('1. [x] Closed goal');
    expect(stopped.reason).toContain('2. [ ] Open goal');
    expect(stopped.reason).toContain(run(['todo', 'ls', '--session', session]).stdout.trim());
    expect(stopped.reason).toContain(run(['goals', '--session', session]).stdout.trim());
    expect(stopped.reason).not.toContain('man pass');
    expect(helmPassStatus('fleet', loadConfig().helm).reasons).toEqual([]);
    expect(run(['hook', 'stop'], { session_id: session, stop_hook_active: true }).stdout).toBe('');
  });
}

it('quiet wait exits 3, delivers the full due details, then clears the pass without a command', () => {
  seat();
  addTodo('fleet', 'Timeout todo');
  setGoals('fleet', goalDate(new Date(), 'UTC'), ['[x] Done', 'Next']);
  const result = run(['man', 'wait', '--session', session, '--timeout', '0.01']);
  expect(result.status, result.stderr).toBe(3);
  expect(result.stdout).toMatch(/^pass-due/);
  expect(result.stdout).toContain(run(['todo', 'ls', '--session', session]).stdout.trim());
  expect(result.stdout).toContain(run(['goals', '--session', session]).stdout.trim());
  expect(readHelmPass('fleet')).toBeDefined();
  const second = run(['man', 'wait', '--session', session, '--timeout', '0.01']);
  expect(second.status).toBe(3);
  expect(second.stdout).not.toContain('pass-due');
}, 10000);

it('a pass that becomes due during a blocking Stop park wakes and records delivery', () => {
  seat('codex');
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "UTC"\npassIntervalSecs = 1\n');
  const prior = recordHelmPass('fleet', loadConfig().helm);
  enqueue({ id: 'pass-queued', repo: 'web', brief: 'keeps the park alive' });
  const result = run(['hook', 'stop', '--timeout', '3'], { session_id: session });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block', reason: expect.stringMatching(/^pass-due.*interval/) });
  expect(readHelmPass('fleet')?.at).not.toBe(prior.at);
}, 10000);

it('previews and existing todo/goals read commands never acknowledge a pass', () => {
  seat();
  for (const args of [['todo', 'ls'], ['goals'], ['man', 'wait', '--peek']]) {
    const result = run([...args, '--session', session]);
    expect(result.status, result.stderr).toBe(0);
    expect(readHelmPass('fleet')).toBeUndefined();
  }
  expect(helmPassNotice('fleet', loadConfig())).toMatch(/^pass-due/);
  expect(readHelmPass('fleet')).toBeUndefined();
});

it('records only after successfully emitting the details, with no repeated delivery', () => {
  seat();
  const config = loadConfig();
  expect(() => deliverHelmPass('fleet', config, () => { throw new Error('delivery failed'); })).toThrow('delivery failed');
  expect(readHelmPass('fleet')).toBeUndefined();
  const details: string[] = [];
  expect(deliverHelmPass('fleet', config, (text) => details.push(text))).toBe(true);
  expect(details[0]).toContain('No goals set.');
  expect(readHelmPass('fleet')).toBeDefined();
  expect(deliverHelmPass('fleet', config, (text) => details.push(text))).toBe(false);
  expect(details).toHaveLength(1);
});

it('glass shows the same last pass age beside goals and todos', async () => {
  seat();
  const now = Date.now();
  addTodo('fleet', 'Review release');
  setGoals('fleet', goalDate(new Date(), 'UTC'), ['Ship release']);
  recordHelmPass('fleet', loadConfig().helm, undefined, now - 7 * 60000);
  const snapshot = buildGlassSnapshot();
  expect(snapshot.helmPasses?.[0]?.lastPassAt).toBe(new Date(now - 7 * 60000).toISOString());
  const page = await loadGlass(GLASS_PAGE, snapshot, { now });
  try {
    expect(page.$('#daily-goals')?.textContent).toContain('last pass 7 min ago');
    expect(page.$('.todos')?.textContent).toContain('last pass 7 min ago');
    page.window.location.hash = '#todos';
    page.serve({ ...snapshot, todos: [] });
    await page.poll();
    expect(page.$('.todos')?.textContent).toContain('No open TODOs');
    expect(page.$('.todos')?.textContent).toContain('last pass 7 min ago');
  } finally { await page.close(); }
});

it('a pass lists every open todo, including future and snoozed items, with due times', () => {
  const now = Date.now();
  addTodo('fleet', 'Waiting one', now, { dueAt: new Date(now + 86400_000).toISOString() });
  const snoozed = addTodo('fleet', 'Snoozed one', now, { dueAt: new Date(now + 86400_000).toISOString() });
  snoozeTodo('fleet', snoozed.id, new Date(now + 2 * 86400_000).toISOString(), now);
  addTodo('fleet', 'Plain one', now);
  addTodo('fleet', 'Late one', now - 86400_000, { dueAt: new Date(now - 1000).toISOString() });
  const notice = helmPassNotice('fleet', loadConfig(), now)!;
  expect(notice).toContain('Waiting one');
  expect(notice).toContain('due');
  expect(notice).toContain('Snoozed one');
  expect(notice).toContain('snoozes');
  expect(notice.indexOf('Plain one')).toBeLessThan(notice.indexOf('Waiting one'));
  expect(notice.indexOf('Late one')).toBeLessThan(notice.indexOf('Plain one'));
  expect(notice).toContain('snooze it');
});

it('a pass with only scheduled todos still lists their names and due times', () => {
  const now = Date.now();
  addTodo('fleet', 'Waiting one', now, { dueAt: new Date(now + 86400_000).toISOString() });
  const notice = helmPassNotice('fleet', loadConfig(), now)!;
  expect(notice).toContain('Waiting one');
  expect(notice).toContain('due');
  expect(notice).not.toContain('todos: none');
});

it('an overdue todo adds no pass reason; a todo with a due is not stale', () => {
  const now = Date.now();
  const config = loadConfig().helm;
  recordHelmPass('fleet', config, undefined, now);
  addTodo('fleet', 'Old with a time', now - 30 * 86400_000, { dueAt: new Date(now - 1000).toISOString() });
  expect(helmPassStatus('fleet', config, now).reasons).toEqual([]);
  expect(helmPassStatus('fleet', config, now).staleTodos).toEqual([]);
});
