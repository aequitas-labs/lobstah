import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, signOnTrap } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

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
  removeTempDir(home);
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

describe('the sign-on title is a step the session confirms', () => {
  const stop = (extra: Record<string, unknown> = {}) =>
    run(['hook', 'stop'], worktree, JSON.stringify({ session_id: 'own-session', hook_event_name: 'Stop', ...extra }));
  const brief = () =>
    (JSON.parse(run(['hook', 'session-start'], worktree, JSON.stringify({ session_id: 'own-session', hook_event_name: 'SessionStart' }))) as {
      hookSpecificOutput: { additionalContext: string };
    }).hookSpecificOutput.additionalContext;

  const REMINDER =
    'lobstah: sign-on is not complete. Apply this title: amber-gull (skip this if you have no tool that sets the session title). Then run `lobstah soak title-set`.';

  it('sign-on says to apply the title; a confirmation from the trap worktree stops the reminders', () => {
    signOn();
    const out = run(['soak', '--session', 'own-session']);
    expect(out).toMatch(
      /step: Apply this title: amber-gull \(skip this if you have no tool that sets the session title\)\. Then run `lobstah soak title-set( --session own-session)?`\. Sign-on is complete after that\./,
    );
    expect(JSON.parse(stop())).toEqual({ decision: 'block', reason: REMINDER });
    // A turn the Stop hook already continued is not reminded again.
    expect(stop({ stop_hook_active: true })).not.toContain('sign-on is not complete');
    expect(brief()).toContain(REMINDER);

    // The step never asks for a command with the word `trap`, which Claude
    // Code's worktree isolation refuses as the shell builtin.
    const confirm = 'soak title-set';
    expect(REMINDER).toContain(`lobstah ${confirm}`);
    expect(REMINDER).not.toMatch(/\btrap\b/);
    expect(run(['soak', 'title-set'])).toContain('signOn: complete');
    expect(stop()).not.toContain('sign-on is not complete');
    expect(brief()).not.toContain('sign-on is not complete');
    // Signing on again in the same session asks nothing new.
    expect(run(['soak', '--session', 'own-session'])).not.toContain('step:');
  });

  it('a confirmation that never comes: two reminders, a last one that says so, then silence', () => {
    signOn();
    run(['soak', '--session', 'own-session']);
    expect(JSON.parse(stop()).reason).toBe(REMINDER);
    expect(JSON.parse(stop()).reason).toBe(REMINDER);
    expect(JSON.parse(stop()).reason).toBe(
      `${REMINDER} This is the last reminder: if the command cannot run here, carry on; lobstah stops asking.`,
    );
    expect(stop()).not.toContain('sign-on is not complete');
    expect(brief()).not.toContain('sign-on is not complete');
    // It can still be confirmed later.
    expect(run(['soak', 'title-set'])).toContain('signOn: complete');
  });

  it('title-set finds the trap by session from outside its worktree; trap title-set is an alias', () => {
    signOn();
    run(['soak', '--session', 'own-session']);
    expect(run(['soak', 'title-set', '--session', 'own-session'], home)).toContain('title: amber-gull');
    signOn();
    expect(run(['trap', 'title-set', '--session', 'own-session'], home)).toContain('signOn: complete');
  });
});
