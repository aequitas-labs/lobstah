import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_HELM, loadConfig } from '../src/config.js';
import { addTodo, closeTodo } from '../src/todos.js';
import { helmPassStatus, readHelmPass, readHelmPassRequest, recordHelmPass, requestHelmPass } from '../src/helm-pass.js';
import { takeHelm, heartbeatHelm } from '../src/helm.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const NOW = Date.parse('2026-11-03T16:00:00Z');
const DAY = 86_400_000;
const CONFIG = { ...DEFAULT_HELM, timezone: 'America/New_York' };
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pass-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

describe('the grounds todo/goals pass', () => {
  it('persists one requested pass per grounds until delivery, without changing todos', () => {
    const todo = addTodo('fleet', 'Review this item', NOW);
    recordHelmPass('fleet', CONFIG, undefined, NOW);
    const request = requestHelmPass('fleet', NOW + 100);
    expect(requestHelmPass('fleet', NOW + 200)).toEqual(request);
    expect(readHelmPassRequest('fleet')).toEqual({ at: new Date(NOW + 100).toISOString() });
    expect(readHelmPassRequest('other')).toBeUndefined();
    expect(helmPassStatus('fleet', CONFIG, NOW + 200).reasons).toEqual(['requested']);
    recordHelmPass('fleet', CONFIG, undefined, NOW + 300);
    expect(readHelmPassRequest('fleet')).toBeUndefined();
    expect(helmPassStatus('fleet', CONFIG, NOW + 301).reasons).toEqual([]);
    expect(readHelmPass('fleet')?.reviewedTodos).toEqual([]);
    expect(todo.state).toBe('open');
  });

  it('keeps a request newer than the pass being delivered and validates its grounds', () => {
    requestHelmPass('fleet', NOW + 200);
    recordHelmPass('fleet', CONFIG, undefined, NOW + 100);
    expect(readHelmPassRequest('fleet')).toBeDefined();
    expect(() => requestHelmPass('../outside', NOW)).toThrow();
    recordHelmPass('fleet', CONFIG, undefined, NOW + 300);
    expect(readHelmPassRequest('fleet')).toBeUndefined();
  });

  it('stands without a pass today, and a delivered pass clears it even with an empty fleet', () => {
    expect(helmPassStatus('fleet', CONFIG, NOW).reasons).toEqual(['daily']);
    recordHelmPass('fleet', CONFIG, 'Reviewed goals and todos', NOW);
    expect(helmPassStatus('fleet', CONFIG, NOW).reasons).toEqual([]);
    expect(readHelmPass('fleet')?.note).toBe('Reviewed goals and todos');
    expect(helmPassStatus('other', CONFIG, NOW).reasons).toEqual(['daily']);
  });

  it('stands at the two-hour interval, not just before, and clears on a pass', () => {
    recordHelmPass('fleet', CONFIG, undefined, NOW);
    expect(helmPassStatus('fleet', CONFIG, NOW + 7_199_999).reasons).toEqual([]);
    expect(helmPassStatus('fleet', CONFIG, NOW + 7_200_000).reasons).toEqual(['interval']);
    recordHelmPass('fleet', CONFIG, undefined, NOW + 7_200_000);
    expect(helmPassStatus('fleet', CONFIG, NOW + 7_200_000).reasons).toEqual([]);
  });

  it('stands for stale todos and acknowledges their versions without immediately looping', () => {
    const old = addTodo('fleet', 'Old commitment', NOW - 4 * DAY);
    const aging = addTodo('fleet', 'Becomes stale later', NOW - 3 * DAY + 1000);
    recordHelmPass('fleet', CONFIG, undefined, NOW - 1000);
    // A newly filed stale item was not reviewed in that pass.
    const newlyFiled = addTodo('fleet', 'Imported old commitment', NOW - 5 * DAY);
    expect(helmPassStatus('fleet', CONFIG, NOW).reasons).toEqual(['stale-todos']);
    expect(helmPassStatus('fleet', CONFIG, NOW).staleTodos.map((todo) => todo.id)).toEqual([old.id, newlyFiled.id]);
    recordHelmPass('fleet', CONFIG, undefined, NOW);
    expect(helmPassStatus('fleet', CONFIG, NOW + 1).reasons).toEqual([]);
    expect(helmPassStatus('fleet', CONFIG, NOW + 1001).reasons).toEqual(['stale-todos']);
    closeTodo('fleet', aging.id, 'done', NOW + 1001);
    expect(helmPassStatus('fleet', CONFIG, NOW + 1001).reasons).toEqual([]);
  });

  it('uses the goals day boundary, even when less than an interval has elapsed', () => {
    const boundary = Date.parse('2026-11-04T09:00:00Z');
    recordHelmPass('fleet', CONFIG, undefined, boundary - 1000);
    expect(helmPassStatus('fleet', CONFIG, boundary - 1).reasons).toEqual([]);
    expect(helmPassStatus('fleet', CONFIG, boundary).reasons).toEqual(['daily']);
  });

  it('survives heartbeats, re-signs and takeovers; they never count as a pass', () => {
    recordHelmPass('fleet', CONFIG, 'prior pass', NOW);
    const seat = (sessionId: string) => takeHelm({ sessionId, grounds: { name: 'fleet', repos: [] }, ttlMs: 60000, take: true });
    seat('first'); heartbeatHelm('first'); seat('first'); seat('replacement');
    expect(readHelmPass('fleet')?.at).toBe(new Date(NOW).toISOString());
    expect(helmPassStatus('fleet', CONFIG, NOW + 7_200_000).reasons).toEqual(['interval']);
  });

  it('honors interval and staleness overrides, with zero disabling only those conditions', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\npassIntervalSecs = 10\ntodoStaleDays = 1\ntimezone = "UTC"\n');
    const configured = loadConfig().helm;
    recordHelmPass('fleet', configured, undefined, NOW);
    expect(helmPassStatus('fleet', configured, NOW + 9999).reasons).toEqual([]);
    expect(helmPassStatus('fleet', configured, NOW + 10000).reasons).toEqual(['interval']);
    addTodo('fleet', 'Two days old', NOW - 2 * DAY);
    expect(helmPassStatus('fleet', { ...configured, passIntervalSecs: 0 }, NOW).reasons).toEqual(['stale-todos']);
    expect(helmPassStatus('fleet', { ...configured, passIntervalSecs: 0, todoStaleDays: 0 }, NOW + 10000).reasons).toEqual([]);
    expect(helmPassStatus('fleet', { ...configured, passIntervalSecs: 0, todoStaleDays: 0 }, NOW + DAY).reasons).toEqual(['daily']);
  });
});
