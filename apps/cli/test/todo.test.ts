import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo, ensureLayout, loadConfig, resolveGrounds, signOnTrap, takeHelm } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = 'helm-session';
const DAY = 24 * 3600 * 1000;
let home: string;

/** The CLI with no harness session env; hook input on stdin when given. */
const run = (args: string[], input?: Record<string, unknown>) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...env, LOBSTAH_HOME: home },
    ...(input ? { input: JSON.stringify({ cwd: home, ...input }) } : {}),
    timeout: 20_000,
  });
};

const helm = () => {
  const cfg = loadConfig();
  takeHelm({ sessionId: HELM, grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000 });
  return resolveGrounds(cfg).name;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('helm to-dos: re-injected beside the charter', () => {
  for (const source of ['startup', 'compact'] as const) {
    it(`SessionStart (${source}) gives the helm its open to-dos`, () => {
      const grounds = helm();
      addTodo(grounds, 'merge #2268 once the API is in production, see https://github.com/o/r/pull/2268');
      addTodo(grounds, 'tag runner 1.4.1');
      const out = run(['hook', 'session-start'], { session_id: HELM, source });
      expect(out.status).toBe(0);
      const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('the helm charter');
      expect(ctx).toContain('[1] merge #2268 once the API is in production, see https://github.com/o/r/pull/2268 — added');
      expect(ctx).toContain('[2] tag runner 1.4.1');
      expect(ctx.indexOf('the helm charter')).toBeLessThan(ctx.indexOf('[1] merge'));
    });
  }

  it('a closed to-do drops out; a session that is not the helm gets none', () => {
    const grounds = helm();
    addTodo(grounds, 'tag runner 1.4.1');
    expect(run(['todo', 'done', '1', '--session', HELM]).status).toBe(0);
    addTodo(grounds, 'still open');
    const ctx = JSON.parse(run(['hook', 'session-start'], { session_id: HELM, source: 'compact' }).stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('tag runner');
    expect(ctx).toContain('[2] still open');
    const other = JSON.parse(run(['hook', 'session-start'], { session_id: 'someone-else' }).stdout).hookSpecificOutput.additionalContext as string;
    expect(other).not.toContain('still open');
  });
});

describe('helm to-dos: helm only', () => {
  it('a trap session is refused; with a claimed helm, another session cannot write', () => {
    helm();
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree);
    signOnTrap({ sessionId: 'trap-session', harness: 'codex', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
    const trap = run(['todo', 'add', 'x', '--session', 'trap-session']);
    expect(trap.status).not.toBe(0);
    expect(trap.stdout + trap.stderr).toContain('a trap keeps none');
    expect(run(['todo', 'add', 'x', '--session', 'other-session']).status).not.toBe(0);
    expect(run(['todo', 'add', 'x', '--session', HELM]).status).toBe(0);
    // The text is the whole to-do: no detail flags.
    expect(run(['todo', 'add', 'x', '--why', 'y', '--session', HELM]).status).toBe(2);
  });
});

describe('helm to-dos: the stale note in tend', () => {
  it('notes to-dos past the default 3 days, and lists them', () => {
    const grounds = helm();
    const now = Date.now();
    addTodo(grounds, 'old one', now - 4 * DAY);
    addTodo(grounds, 'older one', now - 5 * DAY);
    addTodo(grounds, 'fresh one', now - 1 * DAY);
    const r = buildTendReport(now);
    expect(r.todoNote).toBe('2 to-dos older than 3 days: move to the issue tracker?');
    expect(r.todos?.map((t) => [t.text, t.stale])).toEqual([['old one', true], ['older one', true], ['fresh one', false]]);
    const text = renderTend(r);
    expect(text).toContain('2 to-dos older than 3 days: move to the issue tracker?');
    expect(text).toContain('fresh one');
  });

  it('follows [helm].todoStaleDays; none stale, no note', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntodoStaleDays = 7\n');
    const grounds = helm();
    addTodo(grounds, 'four days', Date.now() - 4 * DAY);
    const r = buildTendReport();
    expect(r.todoNote).toBeUndefined();
    expect(renderTend(r)).not.toContain('older than');
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntodoStaleDays = 1\n');
    expect(buildTendReport().todoNote).toBe('1 to-do older than 1 day: move to the issue tracker?');
  });
});
