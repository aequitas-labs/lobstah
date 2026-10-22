import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addTodo, closeTodo, ensureLayout, goalDate, heartbeatHelm, readHelm, setGoals, takeHelm,
} from '@lobstah/core';
import { goalsContext, quietGoalsNudge, todoContext } from '../src/todo.js';
import { buildBriefContext } from '../src/brief.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const DAY = 86_400_000;
const GROUNDS = { name: 'harbor', repos: [] };
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-helm-goals-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "America/New_York"\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function signOn(sessionId = 'helm'): void {
  takeHelm({ sessionId, grounds: GROUNDS, ttlMs: 60_000, take: true });
}

function config(settings: string): void {
  fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\ntimezone = "America/New_York"\n${settings}\n`);
}

describe('goals in the session-start brief', () => {
  it('lists checked and unchecked goals with their one-based commands, only for today', () => {
    setGoals('harbor', '2026-10-21', ['Yesterday']);
    expect(goalsContext('harbor', NOW)).toBe('');
    setGoals('harbor', '2026-10-22', ['[x] Ship it', '[ ] Review it', 'Unmarked is open']);
    expect(goalsContext('harbor', NOW)).toBe([
      "Today's goals (2026-10-22):",
      '1. [x] Ship it', '2. [ ] Review it', '3. [ ] Unmarked is open',
      '`lobstah goals done <n>` as soon as one is met; `lobstah goals undo <n>` if not.',
    ].join('\n'));
  });

  it('injects goals alongside todos only for the helm, including repeated briefs after compaction', async () => {
    signOn();
    const today = goalDate(new Date(), 'America/New_York');
    setGoals('harbor', today, ['[x] Goal in context']);
    addTodo('harbor', 'Todo in context');
    for (let i = 0; i < 2; i++) {
      const context = await buildBriefContext('helm', home);
      expect(context).toContain('[1] Todo in context');
      expect(context).toContain('1. [x] Goal in context');
      expect(context).toContain('`lobstah goals done <n>`');
    }
    expect(await buildBriefContext('someone-else', home)).not.toContain('Goal in context');
  });
});

describe('quiet-timeout goals nudge', () => {
  it('persists the per-session cooldown across repeated timeouts, heartbeats and re-signs', () => {
    signOn();
    setGoals('harbor', '2026-10-22', ['[x] Ship it', 'bao on app store']);
    expect(quietGoalsNudge('harbor', 'helm', NOW)).toBe('goals 1/2 · open: 2. bao on app store');
    heartbeatHelm('helm');
    signOn();
    expect(readHelm('harbor')?.goalsNudge?.date).toBe('2026-10-22');
    expect(quietGoalsNudge('harbor', 'helm', NOW + 1000)).toBeUndefined();
    expect(quietGoalsNudge('harbor', 'helm', NOW + 7_199_999)).toBeUndefined();
    expect(quietGoalsNudge('harbor', 'helm', NOW + 7_200_000)).toBe('goals 1/2 · open: 2. bao on app store');
  });

  it('resets at the next 04:00 local goals day even within the interval', () => {
    signOn();
    const boundary = Date.parse('2026-10-23T08:00:00Z');
    setGoals('harbor', '2026-10-22', ['Yesterday']);
    setGoals('harbor', '2026-10-23', ['Today']);
    expect(quietGoalsNudge('harbor', 'helm', boundary - 1000)).toContain('Yesterday');
    expect(quietGoalsNudge('harbor', 'helm', boundary - 1)).toBeUndefined();
    expect(quietGoalsNudge('harbor', 'helm', boundary)).toBe('goals 0/1 · open: 1. Today');
  });

  it('does not consume allowance without open goals; obeys configured interval and disable', () => {
    signOn();
    expect(quietGoalsNudge('harbor', 'helm', NOW)).toBeUndefined();
    setGoals('harbor', '2026-10-22', ['[x] Done']);
    expect(quietGoalsNudge('harbor', 'helm', NOW)).toBeUndefined();
    expect(readHelm('harbor')?.goalsNudge).toBeUndefined();
    setGoals('harbor', '2026-10-22', ['Open']);
    config('goalsNudgeSecs = 10');
    expect(quietGoalsNudge('harbor', 'helm', NOW)).toBeDefined();
    expect(quietGoalsNudge('harbor', 'helm', NOW + 9999)).toBeUndefined();
    expect(quietGoalsNudge('harbor', 'helm', NOW + 10_000)).toBeDefined();
    config('goalsNudgeSecs = 0');
    expect(quietGoalsNudge('harbor', 'helm', NOW + 20_000)).toBeUndefined();
    expect(readHelm('harbor')?.goalsNudge?.at).toBe(new Date(NOW + 10_000).toISOString());
  });

  it('caps the single line and starts a fresh allowance for a new session, never a foreign one', () => {
    signOn();
    setGoals('harbor', '2026-10-22', ['Open '.repeat(100), 'Another goal']);
    expect(quietGoalsNudge('harbor', 'foreign', NOW)).toBeUndefined();
    const line = quietGoalsNudge('harbor', 'helm', NOW)!;
    expect(line).toHaveLength(200);
    expect(line).toMatch(/…$/);
    expect(line).not.toContain('\n');
    signOn('replacement');
    expect(quietGoalsNudge('harbor', 'helm', NOW + 1)).toBeUndefined();
    expect(quietGoalsNudge('harbor', 'replacement', NOW + 1)).toBe(line);
  });
});

describe('capped session-start todos', () => {
  it('defaults to five oldest open todos, keeps stale markers, and counts the remainder', () => {
    addTodo('harbor', 'Newest', NOW - 1000);
    const closed = addTodo('harbor', 'Closed', NOW - 10 * DAY);
    closeTodo('harbor', closed.id, 'done', NOW);
    for (let i = 0; i < 6; i++) addTodo('harbor', `Old ${i}`, NOW - (9 - i) * DAY);
    const context = todoContext('harbor', NOW);
    expect(context.match(/^-/gm)).toHaveLength(5);
    expect(context).toContain('[3] Old 0 — added 2026-10-13 [stale]');
    expect(context.indexOf('Old 0')).toBeLessThan(context.indexOf('Old 4'));
    expect(context).not.toContain('Old 5');
    expect(context).not.toContain('Newest');
    expect(context).not.toContain('Closed');
    expect(context).toContain('… and 2 more (lobstah todo ls)');
  });

  it('uses the configured cap, omits an empty remainder, and emits no block with no todos', () => {
    expect(todoContext('harbor', NOW)).toBe('');
    addTodo('harbor', 'First', NOW);
    addTodo('harbor', 'Second', NOW + 1);
    config('briefTodoLimit = 1');
    expect(todoContext('harbor', NOW)).toContain('… and 1 more (lobstah todo ls)');
    expect(todoContext('harbor', NOW)).not.toContain('Second');
    config('briefTodoLimit = 2');
    expect(todoContext('harbor', NOW)).not.toContain('more (lobstah todo ls)');
    config('briefTodoLimit = 0');
    expect(todoContext('harbor', NOW)).toContain('… and 2 more (lobstah todo ls)');
    expect(todoContext('harbor', NOW)).not.toContain('- [1]');
  });
});
