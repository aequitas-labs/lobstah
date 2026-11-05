import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { addGrant, ensureLayout, listGrants, parseIntentPattern, revokeGrant, signOnTrap } from '@lobstah/core';
import type { Grant } from '@lobstah/core';
import { intentContextEntry, syncIntentContext } from '../src/intent-context.js';
import { checkCall } from '../src/grants-cli.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
let home: string;
let claudeDir: string;
let codexDir: string;
let worktree: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-intent-cli-')));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  claudeDir = path.join(home, 'claude');
  codexDir = path.join(home, 'codex');
  fs.mkdirSync(claudeDir);
  fs.mkdirSync(codexDir);
  worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = "${worktree.replace(/\\/g, '/')}"\ntrunk = "main"\n`);
  env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const signOn = (name = 'pearl-gull', harness: 'claude' | 'codex' = 'claude', sessionId = SESSION) => {
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness, sessionId, name, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  return signed.ok;
};
const intentGrant = (extra: Partial<Parameters<typeof addGrant>[0]> = {}): Grant =>
  addGrant({ mode: 'intent', by: 'glass', harness: 'claude', trap: 'pearl-gull', intent: { text: 'read-only diagnosis: logs and SELECT queries, no writes', patterns: [parseIntentPattern('npx wrangler tail')] }, ...extra });
const claudeSettings = () => JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as Record<string, any>;
const codexPolicy = () => (parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as { auto_review?: { extra_policy?: string } }).auto_review?.extra_policy;
const bash = (command: string, extra = {}) => ({ harness: 'claude' as const, tool: 'Bash', input: { command }, session: SESSION, ...extra });

describe('a hook honours an intent grant', () => {
  it('allows a matching call in PreToolUse, where other non-session grants wait for a prompt', () => {
    signOn();
    const grant = intentGrant();
    expect(checkCall(bash('npx wrangler tail potluck'), worktree, true)).toEqual([grant.id]);
    expect(checkCall(bash('npx wrangler tail other --format json'), worktree, true)).toEqual([grant.id]);
    expect(listGrants().grants[0]).toMatchObject({ uses: 2 });
  });

  it('leaves everything else in scope to the harness: no decision, no use recorded', () => {
    signOn();
    intentGrant();
    expect(checkCall(bash('npx wrangler deploy'), worktree, true)).toBeUndefined();
    expect(checkCall(bash('npx wrangler tail; rm -rf build'), worktree, true)).toBeUndefined();
    expect(listGrants().grants[0]).toMatchObject({ uses: 0 });
  });

  it('does not change what PreToolUse does for other grants', () => {
    signOn();
    addGrant({ mode: 'always', by: 'glass', harness: 'claude', command: 'npx wrangler tail', match: 'prefix' });
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toBeUndefined();
    expect(checkCall(bash('npx wrangler tail'), worktree, false)).toHaveLength(1);
  });

  it('covers no other session: another trap, a session with no trap, the wrong harness', () => {
    signOn('early-pebble');
    intentGrant();
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toBeUndefined();
    expect(checkCall(bash('npx wrangler tail', { session: 'someone-else' }), worktree, true)).toBeUndefined();
    addGrant({ mode: 'intent', by: 'glass', harness: 'codex', trap: 'early-pebble', intent: { text: 'read logs', patterns: [parseIntentPattern('npx wrangler tail')] } });
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toBeUndefined();
  });

  it('covers a repo-scoped grant from the trap\'s repo', () => {
    signOn();
    const grant = intentGrant({ trap: undefined, repo: 'web' });
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toEqual([grant.id]);
  });

  it('counts a call once when two hooks see it', () => {
    signOn();
    intentGrant();
    const call = bash('npx wrangler tail', { callId: 'toolu_1' });
    checkCall(call, worktree, true);
    checkCall(call, worktree, false);
    expect(listGrants().grants[0]!.uses).toBe(1);
  });

  it('every file in a patch must match, and a tool grant covers a call naming no command or file', () => {
    signOn();
    const grant = intentGrant({ intent: { text: 'write the report', patterns: [parseIntentPattern('path:reports/'), parseIntentPattern('tool:mcp__cloudflare__*')] } });
    const write = (file: string) => ({ harness: 'claude' as const, tool: 'Write', input: { file_path: path.join(worktree, file) }, session: SESSION });
    expect(checkCall(write('reports/a.md'), worktree, true)).toEqual([grant.id]);
    expect(checkCall(write('src/a.ts'), worktree, true)).toBeUndefined();
    expect(checkCall({ harness: 'claude', tool: 'mcp__cloudflare__logs', input: {}, session: SESSION }, worktree, true)).toEqual([grant.id]);
    const patch = '*** Begin Patch\n*** Update File: reports/a.md\n*** Update File: src/a.ts\n*** End Patch';
    expect(checkCall({ harness: 'claude', tool: 'apply_patch', input: { command: patch }, session: SESSION }, worktree, true)).toBeUndefined();
  });
});

describe("the reviewers' context", () => {
  it('tells Claude Code\'s classifier, keeping its built-in context and everything else in the file', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Read(*)'] } }));
    signOn();
    const grant = intentGrant();
    expect(syncIntentContext(env)).toEqual([]);
    const settings = claudeSettings();
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual({ allow: ['Read(*)'] });
    expect(settings.autoMode.environment[0]).toBe('$defaults');
    const entry = settings.autoMode.environment[1] as string;
    expect(entry).toContain(grant.id);
    expect(entry).toContain('read-only diagnosis: logs and SELECT queries, no writes');
    expect(entry).toContain('lobstah trap pearl-gull');
    expect(entry).toContain(worktree);
    expect(entry).toContain('until revoked');
  });

  it('adds beside a list the user has, and removes only its own', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ autoMode: { environment: ['$defaults', 'my own note'] } }));
    const grant = intentGrant();
    syncIntentContext(env);
    expect(claudeSettings().autoMode.environment).toEqual(['$defaults', 'my own note', intentContextEntry(listGrants().grants[0]!)]);
    revokeGrant(grant.id, 'glass');
    syncIntentContext(env);
    expect(claudeSettings().autoMode.environment).toEqual(['$defaults', 'my own note']);
  });

  it('leaves the settings as it found them once the last grant goes', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const grant = intentGrant();
    syncIntentContext(env);
    expect(claudeSettings().autoMode).toBeDefined();
    revokeGrant(grant.id, 'glass');
    syncIntentContext(env);
    expect(claudeSettings()).toEqual({ model: 'opus' });
  });

  it('removes a grant that lapsed', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
    addGrant(
      { mode: 'intent', by: 'glass', harness: 'claude', trap: 'pearl-gull', intent: { text: 'read logs', patterns: [] }, expiresAt: new Date(Date.now() + 40).toISOString() },
    );
    syncIntentContext(env);
    expect(JSON.stringify(claudeSettings())).toContain('read logs');
    const until = Date.now() + 60;
    while (Date.now() < until) { /* past the expiry */ }
    syncIntentContext(env);
    expect(JSON.stringify(claudeSettings())).not.toContain('read logs');
  });

  it("tells Codex's reviewer in a block of its own, leaving the user's text and lobstah's profile block", () => {
    const profile = '<!-- lobstah:begin (written by `lobstah permissions`; edits inside are replaced) -->\nprofile\n<!-- lobstah:end -->';
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "x"\n# a comment\n\n[auto_review]\nextra_policy = """my own policy\n\n${profile}"""\n\n[other]\nkept = true\n`);
    const grant = intentGrant({ harness: 'codex' });
    expect(syncIntentContext(env)).toEqual([]);
    const policy = codexPolicy()!;
    expect(policy).toContain('my own policy');
    expect(policy).toContain(profile);
    expect(policy).toContain('read-only diagnosis');
    const text = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(text).toContain('# a comment');
    expect(parse(text)).toMatchObject({ model: 'x', other: { kept: true } });
    revokeGrant(grant.id, 'glass');
    syncIntentContext(env);
    expect(codexPolicy()).toBe(`my own policy\n\n${profile}`);
    expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toContain('# a comment');
  });

  it('removes the Codex policy it created', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "x"\n');
    const grant = intentGrant({ harness: 'codex' });
    syncIntentContext(env);
    expect(codexPolicy()).toContain('read-only diagnosis');
    revokeGrant(grant.id, 'glass');
    syncIntentContext(env);
    expect(codexPolicy()).toBeUndefined();
  });

  it('tells each harness only about its own grants', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '');
    intentGrant({ harness: 'codex' });
    syncIntentContext(env);
    expect(JSON.stringify(claudeSettings())).not.toContain('read-only diagnosis');
    expect(codexPolicy()).toContain('read-only diagnosis');
  });

  it('does not write again when nothing changed', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
    intentGrant();
    syncIntentContext(env);
    const file = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(file, '{"changed":"by someone else"}');
    syncIntentContext(env);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"changed":"by someone else"}');
  });

  it('reports a settings file it cannot read, and the grant still works', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), 'not json');
    signOn();
    const grant = intentGrant();
    expect(syncIntentContext(env)[0]).toContain('not valid JSON');
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('not json');
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toEqual([grant.id]);
  });

  it('skips a harness that is not set up here', () => {
    expect(syncIntentContext({ CLAUDE_CONFIG_DIR: path.join(home, 'none'), CODEX_HOME: path.join(home, 'none-either') })).toEqual([]);
    expect(fs.existsSync(path.join(home, 'none'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'none-either'))).toBe(false);
  });

  it('names a repo-scoped grant by its repo, and a timed grant by its end', () => {
    const entry = intentContextEntry(intentGrant({ trap: undefined, repo: 'web', expiresAt: '2030-01-01T00:00:00.000Z' }));
    expect(entry).toContain('the lobstah traps of repo web');
    expect(entry).toContain('until 2030-01-01T00:00:00.000Z');
  });
});

describe('lobstah grant ls and grant revoke', () => {
  /** The CLI as an agent session runs it: no terminal, and an agent's environment. */
  const lobstah = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env, LOBSTAH_HOME: home, CLAUDE_CODE_SESSION_ID: 'helm-session' } });

  it('lists active grants with their scope, intent, patterns, expiry, uses and last use', () => {
    signOn();
    intentGrant({ expiresAt: '2030-01-01T00:00:00.000Z' });
    checkCall(bash('npx wrangler tail'), worktree, true);
    const out = lobstah('grant', 'ls');
    expect(out.status, out.stderr).toBe(0);
    for (const text of ['pearl-gull', 'read-only diagnosis: logs and SELECT queries', 'npx wrangler tail', '2030-01-01T00:00:00.000Z', 'lastUsed', 'patterns']) expect(out.stdout).toContain(text);
    const parsed = JSON.parse(lobstah('grant', 'ls', '--json').stdout) as { grants: Grant[] };
    expect(parsed.grants[0]).toMatchObject({ mode: 'intent', uses: 1 });
    expect(parsed.grants[0]!.lastUsedAt).toBeTruthy();
  });

  it('revokes from an agent session, which the helm is, and stops the grant', () => {
    signOn();
    const grant = intentGrant();
    const out = lobstah('grant', 'revoke', grant.id);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(grant.id);
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toBeUndefined();
    expect(lobstah('grant', 'ls').stdout).not.toContain(grant.id);
    expect(lobstah('grant', 'ls', '--all').stdout).toContain(grant.id);
  });

  it('takes the revoked grant out of the reviewers\' context', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
    const grant = intentGrant();
    syncIntentContext(env);
    expect(JSON.stringify(claudeSettings())).toContain(grant.id);
    expect(lobstah('grant', 'revoke', grant.id).status).toBe(0);
    expect(JSON.stringify(claudeSettings())).not.toContain(grant.id);
  });

  it('asks for an id, and says so for an unknown one', () => {
    expect(lobstah('grant', 'revoke').status).not.toBe(0);
    const unknown = lobstah('grant', 'revoke', 'g-nope');
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr + unknown.stdout).toContain('no grant g-nope');
  });

  it('still refuses to grant from an agent session', () => {
    const out = lobstah('grant', 'npx wrangler tail', '--yes');
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toContain('not an agent session');
    expect(listGrants().grants).toEqual([]);
  });
});
