import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, signOnTrap } from '@lobstah/core';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-title-cli-'));
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function signOn() {
  const result = signOnTrap({ sessionId: 'own-session', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 1_800_000, name: 'amber-gull' });
  if ('held' in result) throw new Error('unexpected hold');
  return result.ok;
}

function run(args: string[], cwd = worktree, stdin?: string) {
  const env = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, input: stdin, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('title fields on trap commands', () => {
  it('rejects the removed title subcommand and its JSON flag', () => {
    const env = { ...process.env, LOBSTAH_HOME: home };
    for (const args of [['soak', 'title'], ['soak', '--json', '--session', 'own-session']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: worktree, env, encoding: 'utf8' });
      expect(result.status).toBe(2);
    }
  });

  it('prints the name at sign-on, work on delivery, and the name after done or failed', () => {
    signOn();
    expect(run(['soak', '--session', 'own-session'])).toContain('title: amber-gull');
    enqueue({ id: 'title-work', repo: 'web', brief: '# Ship a short feature\nIgnore this line' });
    expect(run(['soak', '--wait', '--timeout', '0', '--session', 'own-session'])).toContain('title: amber-gull · Ship a short feature');
    expect(run(['report', 'title-work', 'done', 'finished'])).toContain('title: amber-gull');

    enqueue({ id: 'second-work', repo: 'web', brief: '# Another feature' });
    expect(run(['soak', '--wait', '--timeout', '0', '--session', 'own-session'])).toContain('title: amber-gull · Another feature');
    expect(run(['report', 'second-work', 'failed', 'cannot finish'])).toContain('title: amber-gull');
  });

  it('a done with --report keeps the trap name as the title and prints the report title apart', () => {
    signOn();
    enqueue({ id: 'report-work', repo: 'web', brief: '# Research trays' });
    run(['soak', '--wait', '--timeout', '0', '--session', 'own-session']);
    const page = path.join(home, 'findings.md');
    fs.writeFileSync(page, '# Tray findings\n\nnotes');
    const lines = run(['report', 'report-work', 'done', 'filed', '--report', page]).split('\n');
    expect(lines).toContain('title: amber-gull');
    expect(lines).toContain('reportTitle: Tray findings');
  });

  it('prints the cleaned, capped first brief line when work is delivered', () => {
    signOn();
    enqueue({ id: 'clean-work', repo: 'web', brief: '## \u001b[31mShip safe work\u001b[0m ' + 'long '.repeat(100) + '\nignore this' });
    const output = run(['soak', '--wait', '--timeout', '0', '--session', 'own-session']);
    const title = output.split('\n').filter((line) => line.startsWith('title: ')).at(-1)?.slice(7) ?? '';
    expect(title).toContain('amber-gull · Ship safe work');
    expect(title).not.toContain('\u001b');
    expect(title).not.toContain('ignore this');
    expect(Array.from(title.split(' · ')[1] ?? '').length).toBeLessThanOrEqual(40);
  });

  it('leaves the SessionStart brief unchanged', () => {
    signOn();
    const input = JSON.stringify({ session_id: 'own-session', cwd: worktree, hook_event_name: 'SessionStart' });
    const ordinary = JSON.parse(run(['man', 'brief'], worktree, input));
    expect(ordinary.hookSpecificOutput.sessionTitle).toBeUndefined();
    expect(ordinary.hookSpecificOutput.additionalContext).toContain('own-session');
  });
});
