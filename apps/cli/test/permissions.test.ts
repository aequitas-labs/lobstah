import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  baseProfile,
  desiredProfile,
  EMPTY_PROFILE,
  permissionsCommand,
  permissionsRow,
  planProfile,
  readOwned,
  rulePath,
} from '../src/permissions.js';
import type { Profile } from '../src/permissions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string, claudeDir: string, file: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-permissions-'));
  claudeDir = path.join(home, '.claude');
  file = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir);
  process.env.LOBSTAH_HOME = path.join(home, '.lobstah');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const NO_EXT = { environment: [], allow: [], deny: [], codex: { forbidden: [], prompt: [], allow: [] } };
const profile = (p: Partial<Profile>): Profile => ({ ...EMPTY_PROFILE, ...p });
/** A person's terminal: no agent variables, Claude settings in the temp home. */
const person = () => ({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'no-codex') }) as NodeJS.ProcessEnv;
const run = async (sub: string | undefined, opts: { yes?: boolean; env?: NodeJS.ProcessEnv; tty?: boolean; ask?: () => boolean } = {}) => {
  const out: string[] = [];
  await permissionsCommand(sub, { yes: opts.yes ?? false }, { env: opts.env ?? person(), tty: opts.tty ?? false, log: (s) => out.push(s), ask: opts.ask });
  return out.join('\n');
};
const USER = {
  model: 'opus',
  permissions: { allow: ['Bash(npm run test *)'], defaultMode: 'auto' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'lobstah hook stop' }] }] },
};

describe('the profile', () => {
  it('names lobstah worktrees as dev checkouts, the helm acting on the chat as no bypass, and a glass answer as the user\'s own; adds no restriction; allows Read/Edit there', () => {
    const p = baseProfile('/h/.lobstah/worktrees', 4949);
    expect(p.environment.join('\n')).toMatch(/\/h\/\.lobstah\/worktrees\/ are the user's own development checkouts/);
    expect(p.environment.join('\n')).toMatch(/not Auto-Mode Bypass/);
    expect(p.environment.join('\n')).toMatch(/glass \(127\.0\.0\.1:4949\) is the user's own UI on this machine\. A `decision-answer` event with `from: glass`/);
    expect(p.environment).toHaveLength(3);
    expect(p.deny).toEqual([]);
    expect(p.allow).toEqual(['Read(//h/.lobstah/worktrees/**)', 'Edit(//h/.lobstah/worktrees/**)', 'Bash(lobstah permissions propose *)']);
  });

  it('writes absolute rule paths the way Claude Code matches them, Windows drives included', () => {
    expect(rulePath('/Users/x/.lobstah/worktrees')).toBe('//Users/x/.lobstah/worktrees');
    expect(rulePath('C:\\Users\\x\\.lobstah\\worktrees', 'win32')).toBe('//c/Users/x/.lobstah/worktrees');
  });
});

describe('merging into Claude Code settings', () => {
  it('keeps every existing key and rule, adds only what is missing, and starts a new environment with $defaults', () => {
    const desired = profile({ environment: ['ctx'], allow: ['Bash(npm run test *)', 'Edit(//w/**)'], deny: ['Bash(env pull *)'] });
    const plan = planProfile(USER, desired);
    expect(plan.settings).toEqual({
      ...USER,
      permissions: { allow: ['Bash(npm run test *)', 'Edit(//w/**)'], defaultMode: 'auto', deny: ['Bash(env pull *)'] },
      autoMode: { environment: ['$defaults', 'ctx'] },
    });
    // The user's own rule is never claimed: removing the profile leaves it.
    expect(plan.owned).toEqual({ environment: ['$defaults', 'ctx'], allow: ['Edit(//w/**)'], deny: ['Bash(env pull *)'] });
    expect(planProfile(plan.settings, EMPTY_PROFILE, plan.owned).settings).toEqual(USER);
  });

  it("a re-run removes only lobstah's stale entries and is otherwise a no-op", () => {
    const first = planProfile(USER, profile({ allow: ['A', 'B'] }));
    const second = planProfile(first.settings, profile({ allow: ['A'] }), first.owned);
    expect(second.changes).toEqual([{ op: '-', at: 'permissions.allow', entry: 'B' }]);
    expect(planProfile(second.settings, profile({ allow: ['A'] }), second.owned).changes).toEqual([]);
  });

  it('owns an entry rewritten in place under the heading of one it owned: never duplicated, and removed with the profile', () => {
    const old = '**lobstah rule**: old text';
    const next = '**lobstah rule**: new text';
    const first = planProfile({}, profile({ environment: [old] }));
    const edited = { autoMode: { environment: ['$defaults', next, 'mine'] } };
    const reapplied = planProfile(edited, profile({ environment: [next] }), first.owned);
    expect(reapplied.changes).toEqual([]);
    expect(reapplied.owned.environment).toEqual(['$defaults', next]);
    expect(planProfile(edited, EMPTY_PROFILE, first.owned).settings).toEqual({ autoMode: { environment: ['$defaults', 'mine'] } });
    const newer = '**lobstah rule**: newer text';
    expect(planProfile(edited, profile({ environment: [newer] }), first.owned).settings).toEqual({ autoMode: { environment: ['$defaults', 'mine', newer] } });
    // Without an owned entry under that heading, the same text is the user's and never claimed.
    expect(planProfile(edited, profile({ environment: [next] })).owned.environment).toEqual([]);
  });

  it('a re-apply retires the old human-only entry, hand-edited text included, and keeps the rest', () => {
    const base = baseProfile('/h/.lobstah/worktrees', 4949);
    const owned = { environment: ['$defaults', ...base.environment, '**lobstah human-only actions**: recorded text'], allow: base.allow, deny: [] };
    const settings = { model: 'opus', permissions: { allow: [...base.allow] }, autoMode: { environment: ['$defaults', ...base.environment, '**lobstah human-only actions**: hand-edited text', 'mine'] } };
    const plan = planProfile(settings, base, owned);
    expect(plan.changes).toEqual([{ op: '-', at: 'autoMode.environment', entry: '**lobstah human-only actions**: hand-edited text' }]);
    expect(plan.settings).toEqual({ ...settings, autoMode: { environment: ['$defaults', ...base.environment, 'mine'] } });
  });

  it("leaves an existing environment list's choice about $defaults alone, and keeps $defaults while the user's entries remain", () => {
    const replaced = { autoMode: { environment: ['mine only'] } };
    expect(planProfile(replaced, profile({ environment: ['ctx'] })).settings).toEqual({ autoMode: { environment: ['mine only', 'ctx'] } });
    const applied = planProfile({}, profile({ environment: ['ctx'] }));
    const userAdded = { autoMode: { environment: [...(applied.settings.autoMode as { environment: string[] }).environment, 'mine'] } };
    expect(planProfile(userAdded, EMPTY_PROFILE, applied.owned).settings).toEqual({ autoMode: { environment: ['$defaults', 'mine'] } });
  });

  it('refuses settings it cannot merge into safely', () => {
    expect(() => planProfile([], EMPTY_PROFILE)).toThrow(/must be a JSON object/);
    expect(() => planProfile({ permissions: { allow: 'Read' } }, profile({ allow: ['A'] }))).toThrow(/permissions\.allow .* not a list of strings/);
  });
});

describe('lobstah permissions', () => {
  it('bare shows the diff and writes nothing', async () => {
    fs.writeFileSync(file, JSON.stringify(USER));
    const out = await run(undefined);
    expect(out).toContain(`+ autoMode.environment: "$defaults"`);
    expect(out).toMatch(/\+ permissions\.allow: "Edit\(\/\/.*worktrees\/\*\*\)"/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(USER);
  });

  it('apply asks before writing; no answer, no tty, or an agent shell writes nothing', async () => {
    fs.writeFileSync(file, JSON.stringify(USER));
    await expect(run('apply')).rejects.toThrow(/no terminal to confirm; re-run with --yes/);
    expect(await run('apply', { tty: true, ask: () => false })).toContain('written: false');
    await expect(run('apply', { yes: true, env: { ...person(), CLAUDECODE: '1' } })).rejects.toThrow(/for a person, not an agent session \(CLAUDECODE is set\)/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(USER);
  });

  it('apply backs up the previous file, merges, records ownership; remove restores the original', async () => {
    fs.writeFileSync(file, JSON.stringify(USER));
    const out = await run('apply', { tty: true, ask: () => true });
    expect(out).toContain('written: true');
    const backup = /backup: (.*)/.exec(out)![1]!;
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(USER);
    const applied = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(applied.model).toBe('opus');
    expect(applied.permissions.allow[0]).toBe('Bash(npm run test *)');
    expect(readOwned(file).allow).toHaveLength(3);
    expect(await run(undefined)).toContain("lobstah's profile is applied and current");
    await run('remove', { yes: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(USER);
    expect(readOwned(file)).toEqual(EMPTY_PROFILE);
  });

  it('refuses a settings file that is not valid JSON, leaving it as it was', async () => {
    fs.writeFileSync(file, '{ "model": "opus", }');
    await expect(run('apply', { yes: true })).rejects.toThrow(/is not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "model": "opus", }');
  });
});

describe('doctor', () => {
  it('reports the profile missing, current, and out of date', async () => {
    const env = person();
    expect(permissionsRow(NO_EXT, env)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/not applied/) });
    await run('apply', { yes: true });
    expect(permissionsRow(NO_EXT, env)).toMatchObject({ status: 'ok' });
    expect(permissionsRow({ ...NO_EXT, deny: ['Bash(env pull *)'] }, env)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/out of date \(1 to add, 0 to remove\)/) });
    expect(permissionsRow(NO_EXT, { CLAUDE_CONFIG_DIR: path.join(home, 'nowhere') })).toMatchObject({ status: 'skip' });
  });

  it('desired is the base profile plus config, each entry once', () => {
    const base = baseProfile('/h/worktrees');
    expect(desiredProfile({ ...NO_EXT, allow: [base.allow[0]!, 'X'] }, base).allow).toEqual([...base.allow, 'X']);
  });
});
