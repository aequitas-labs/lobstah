import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, addTodo, ensureLayout, goalDate, helmPassStatus, loadConfig, readHelmPass, recordHelmPass, setGoals, takeHelm } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { HELM_PASS_RULE, charter } from '../src/charter.js';
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

it('sign-on leads with pass-due and the charter carries the shared routine', () => {
  const result = run(['man', 'helm', '--session', session]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^pass-due/);
  expect(result.stdout).toContain(HELM_PASS_RULE);
  expect(charter({ name: 'fleet', repos: [] })).toContain(HELM_PASS_RULE);
});

it('man pass lists all todos stale first, goal done states, records the note, and clears the notice', () => {
  seat();
  const now = Date.now();
  addTodo('fleet', 'Newer todo', now);
  addTodo('fleet', 'Stale todo', now - 4 * 86400000);
  setGoals('fleet', goalDate(new Date(), 'UTC'), ['[x] Shipped', 'Review next']);
  const result = run(['man', 'pass', '--session', session, '--note', 'Review complete']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.indexOf('Stale todo')).toBeLessThan(result.stdout.indexOf('Newer todo'));
  expect(result.stdout).toContain('1. [x] Shipped');
  expect(result.stdout).toContain('2. [ ] Review next');
  expect(readHelmPass('fleet')?.note).toBe('Review complete');
  expect(helmPassStatus('fleet', loadConfig().helm).reasons).toEqual([]);
  expect(run(['hook', 'stop'], { session_id: session }).stdout).toBe('');
});

for (const harness of ['claude', 'codex'] as const) {
  it(`${harness}: Stop blocks repeatedly on pass-due with an empty fleet or live watcher until man pass`, () => {
    seat(harness);
    addTodo('fleet', 'Stale reminder', Date.now() - 4 * 86400000);
    setGoals('fleet', goalDate(new Date(), 'UTC'), ['[x] Closed goal', 'Open goal']);
    fs.writeFileSync(path.join(home, 'watchers', `${session}.json`), JSON.stringify({ sessionId: session, kind: 'man', pid: process.pid, heartbeatAt: new Date().toISOString() }));
    for (let i = 0; i < 2; i++) {
      const result = run(['hook', 'stop'], { session_id: session, stop_hook_active: i > 0 });
      expect(result.status, result.stderr).toBe(0);
      const stopped = JSON.parse(result.stdout);
      expect(stopped.decision).toBe('block');
      expect(stopped.reason).toMatch(/^pass-due/);
      expect(stopped.reason).toContain(`lobstah man pass --grounds home --session ${session}`);
      expect(stopped.reason).toContain('Stale reminder');
      expect(stopped.reason).toContain('open goal 2: Open goal');
      expect(stopped.reason).not.toContain('Closed goal');
      expect(readHelmPass('fleet')).toBeUndefined();
    }
    expect(run(['man', 'pass', '--session', session]).status).toBe(0);
    expect(run(['hook', 'stop'], { session_id: session }).stdout).toBe('');
  });
}

it('quiet wait exits 3 with a leading pass-due notice every time, until a pass is recorded', () => {
  seat();
  for (let i = 0; i < 2; i++) {
    const result = run(['man', 'wait', '--session', session, '--timeout', '0.01']);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toMatch(/^pass-due/);
    expect(result.stdout).toContain('lobstah man pass --grounds home');
  }
  expect(run(['man', 'pass', '--session', session]).status).toBe(0);
  const result = run(['man', 'wait', '--session', session, '--timeout', '0.01']);
  expect(result.status).toBe(3);
  expect(result.stdout).not.toContain('pass-due');
}, 10000);

it('a pass that becomes due during a blocking Stop park wakes the helm', () => {
  seat('codex');
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "UTC"\npassIntervalSecs = 1\n');
  recordHelmPass('fleet', loadConfig().helm);
  enqueue({ id: 'pass-queued', repo: 'web', brief: 'keeps the park alive' });
  const result = run(['hook', 'stop', '--timeout', '3'], { session_id: session });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block', reason: expect.stringMatching(/^pass-due.*interval/) });
}, 10000);

it('does not let a foreign helm clear another grounds pass', () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '[grounds.alpha]\nrepos = []\n[grounds.beta]\nrepos = []\n');
  takeHelm({ sessionId: session, grounds: { name: 'alpha', repos: [] }, ttlMs: 60000 });
  takeHelm({ sessionId: 'other', grounds: { name: 'beta', repos: [] }, ttlMs: 60000 });
  const result = run(['man', 'pass', '--session', session, '--grounds', 'beta']);
  expect(result.status).not.toBe(0);
  expect(readHelmPass('beta')).toBeUndefined();
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
