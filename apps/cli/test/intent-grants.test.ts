import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addGrant, ensureLayout, listGrants, parseIntentPattern, revokeGrant, signOnTrap } from '@lobstah/core';
import type { Grant } from '@lobstah/core';
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
/** A Codex trap and a Claude Code trap read the same grant the same way. */
const intentGrant = (extra: Partial<Parameters<typeof addGrant>[0]> = {}): Grant =>
  addGrant({ mode: 'intent', by: 'glass', harness: 'claude', trap: 'pearl-gull', intent: { text: 'read-only diagnosis: logs and SELECT queries, no writes', patterns: [parseIntentPattern('npx wrangler tail')] }, ...extra });
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

  it('means the same on Codex: the same patterns, through the same check', () => {
    signOn('pearl-gull', 'codex');
    const grant = intentGrant({ harness: 'any' });
    const call = { harness: 'codex' as const, tool: 'exec_command', input: { cmd: 'npx wrangler tail potluck' }, session: SESSION };
    expect(checkCall(call, worktree, true)).toEqual([grant.id]);
    expect(checkCall({ ...call, input: { cmd: 'npx wrangler deploy' } }, worktree, true)).toBeUndefined();
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

  it('counts a Codex call once, though only its first hook names the call', () => {
    signOn('pearl-gull', 'codex');
    intentGrant({ harness: 'any' });
    const input = { command: 'npx wrangler tail' };
    const preToolUse = { harness: 'codex' as const, tool: 'Bash', input, session: SESSION, callId: 'exec-1', turn: 'turn-1' };
    const permissionRequest = { harness: 'codex' as const, tool: 'Bash', input, session: SESSION, turn: 'turn-1' };
    checkCall(preToolUse, worktree, true);
    checkCall(permissionRequest, worktree, false);
    expect(listGrants().grants[0]!.uses).toBe(1);
    checkCall({ ...preToolUse, callId: 'exec-2', turn: 'turn-2' }, worktree, true);
    expect(listGrants().grants[0]!.uses).toBe(2);
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

describe('no harness configuration is touched', () => {
  it('making, using and revoking a grant leaves Claude Code and Codex config as it was', () => {
    const claudeFile = path.join(claudeDir, 'settings.json');
    const codexFile = path.join(codexDir, 'config.toml');
    const claudeBefore = JSON.stringify({ model: 'opus', autoMode: { environment: ['$defaults', 'my own note'] } });
    const codexBefore = 'model = "x"\n# a comment\n\n[auto_review]\nextra_policy = "my own policy"\n';
    fs.writeFileSync(claudeFile, claudeBefore);
    fs.writeFileSync(codexFile, codexBefore);
    signOn();
    const grant = intentGrant();
    expect(checkCall(bash('npx wrangler tail'), worktree, true)).toEqual([grant.id]);
    expect(checkCall(bash('npx wrangler deploy'), worktree, true)).toBeUndefined();
    const revoked = spawnSync(process.execPath, [cli, 'grant', 'revoke', grant.id], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env, LOBSTAH_HOME: home } });
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(fs.readFileSync(claudeFile, 'utf8')).toBe(claudeBefore);
    expect(fs.readFileSync(codexFile, 'utf8')).toBe(codexBefore);
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
