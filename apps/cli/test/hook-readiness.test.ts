import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, signOnTrap } from '@lobstah/core';
import { claudeHooks, codexHookHash, codexHooks, hookRow, listenerRow } from '../src/hook-readiness.js';
import type { LobstahHook } from '../src/hook-runs.js';
import { readHookRuns, recordHookRun } from '../src/hook-runs.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const NOW = Date.parse('2026-09-30T12:00:00Z');
let dir: string;
let home: string;

const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'lobstah hook session-start', timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'lobstah hook post-tool-use', timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'lobstah hook stop', timeout: 14400 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'lobstah hook session-end', timeout: 3 }] }],
  },
};

/** A Codex home with the lobstah plugin cached and `config` as its config.toml. */
function codexHome(config: string, hooks: object = HOOKS_JSON): void {
  const root = path.join(home, '.codex', 'plugins', 'cache', 'lobstah', 'lobstah', '0.6.3');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'lobstah', version: '0.6.3' }));
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(hooks));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[plugins."lobstah@lobstah"]\nenabled = true\n\n${config}`);
}

const EVENT: Record<string, LobstahHook> = { stop: 'Stop', session_start: 'SessionStart', post_tool_use: 'PostToolUse', session_end: 'SessionEnd' };
type Hooks = { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> };
/** Codex's trust entry for the hook as `hooks` declares it. */
const trust = (event: string, extra = '', hooks: Hooks = HOOKS_JSON) => {
  const hash = codexHookHash(EVENT[event]!, undefined, hooks.hooks[EVENT[event]!]![0]!.hooks[0]!);
  return `[hooks.state."lobstah@lobstah:hooks/hooks.json:${event}:0:0"]\ntrusted_hash = "${hash}"\n${extra}\n`;
};
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv, now: NOW });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hooks-'));
  home = path.join(dir, 'user');
  fs.mkdirSync(home);
  process.env.LOBSTAH_HOME = path.join(dir, 'lobstah');
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

describe('doctor: Codex hook readiness', () => {
  it('all four trusted and run: ok, with each last run', () => {
    codexHome(['stop', 'session_start', 'post_tool_use', 'session_end'].map((e) => trust(e)).join('\n'));
    for (const hook of ['Stop', 'SessionStart', 'PostToolUse', 'SessionEnd']) recordHookRun(hook, 'codex', NOW - 120_000);
    const row = hookRow(codexHooks(opts()), NOW);
    expect(row.status).toBe('ok');
    expect(row.detail).toBe(
      'helm ready, trap ready. Stop: installed, trusted, last run 2m ago; SessionStart: installed, trusted, last run 2m ago; ' +
        'PostToolUse: installed, trusted, last run 2m ago; SessionEnd: installed, trusted, last run 2m ago',
    );
  });

  it('untrusted Stop and SessionStart, never run: not healthy, and the remedy names /hooks', () => {
    codexHome(trust('post_tool_use') + trust('session_end'));
    const h = codexHooks(opts());
    expect(h.hooks.map((x) => [x.hook, x.installed, x.trusted, x.lastRun])).toEqual([
      ['Stop', true, 'untrusted', undefined],
      ['SessionStart', true, 'untrusted', undefined],
      ['PostToolUse', true, 'trusted', undefined],
      ['SessionEnd', true, 'trusted', undefined],
    ]);
    const row = hookRow(h, NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/^helm not ready \(needs Stop and SessionStart\), trap not ready \(needs Stop and SessionStart\)\. /);
    expect(row.detail).toContain('Stop: installed, untrusted, never run');
    expect(row.detail).toContain("In Codex, open /hooks and trust lobstah's Stop and SessionStart hooks.");
  });

  it('a hook the plugin does not declare is missing; a disabled one names /hooks too', () => {
    const { Stop: _stop, ...rest } = HOOKS_JSON.hooks;
    codexHome(trust('session_start') + trust('post_tool_use', 'enabled = false') + trust('session_end'), { hooks: rest });
    const row = hookRow(codexHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/^helm not ready \(needs Stop\), trap not ready \(needs Stop and PostToolUse\)\. /);
    expect(row.detail).toContain('Stop: missing, never run');
    expect(row.detail).toContain('PostToolUse: installed but disabled, trusted');
    expect(row.detail).toContain('the plugin does not declare Stop: reinstall it');
    expect(row.detail).toContain("In Codex, open /hooks and enable lobstah's PostToolUse hook");
  });

  it('the helm can be ready while a trap is not', () => {
    codexHome(trust('stop') + trust('session_start') + trust('session_end'));
    const row = hookRow(codexHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/^helm ready, trap not ready \(needs PostToolUse\)\. /);
  });

  it('an older plugin that runs the alias commands is read the same way', () => {
    const old = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'lobstah man brief' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'lobstah soak beat' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'lobstah man haul' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'lobstah stow --quiet' }] }],
      },
    };
    codexHome(['stop', 'session_start', 'post_tool_use', 'session_end'].map((e) => trust(e, '', old)).join('\n'), old);
    expect(hookRow(codexHooks(opts()), NOW).status).toBe('ok');
  });

  it('a hook that changed since it was trusted is not trusted: Codex asks again', () => {
    // Trusted as `lobstah soak beat`; the plugin now runs `lobstah hook post-tool-use`.
    const old = { hooks: { ...HOOKS_JSON.hooks, PostToolUse: [{ hooks: [{ type: 'command', command: 'lobstah soak beat', timeout: 5 }] }] } };
    codexHome(trust('stop') + trust('session_start') + trust('post_tool_use', '', old) + trust('session_end'));
    const row = hookRow(codexHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('PostToolUse: installed, changed since trusted, never run');
    expect(row.detail).toContain("In Codex, open /hooks and trust lobstah's PostToolUse hook.");
  });

  it("the hash is Codex's: two trust entries Codex wrote for lobstah 0.6.3", () => {
    expect(codexHookHash('PostToolUse', undefined, { type: 'command', command: 'lobstah soak beat', timeout: 5 })).toBe(
      'sha256:20180ee5a463cab93ae2e9a9ef36bda89742ee4e4229d30e1485d4fe767adf9f',
    );
    expect(codexHookHash('SessionEnd', undefined, { type: 'command', command: 'lobstah stow --quiet', timeout: 3 })).toBe(
      'sha256:b3e81d99f7cbab1779a0106ee123c64e5b3107284fa61035ad4df120a6f6977b',
    );
  });

  it('hooks turned off in Codex fail the row even when trusted', () => {
    codexHome(`[features]\nhooks = false\n\n${['stop', 'session_start', 'post_tool_use', 'session_end'].map((e) => trust(e)).join('\n')}`);
    const row = hookRow(codexHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('[features] hooks = false');
  });

  it('no Codex plugin: skip', () => {
    expect(hookRow(codexHooks(opts()), NOW)).toEqual({ check: 'hooks codex', status: 'skip', detail: 'plugin not installed' });
  });

  it('never writes the Codex config', () => {
    codexHome(trust('post_tool_use'));
    const file = path.join(home, '.codex', 'config.toml');
    const before = fs.readFileSync(file, 'utf8');
    hookRow(codexHooks(opts()), NOW);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('doctor: Claude Code hook readiness', () => {
  function claudeHome(settings: object): void {
    const root = path.join(home, 'plugin');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lobstah', version: '0.6.3' }));
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'lobstah@lobstah': [{ installPath: root, version: '0.6.3' }] } }),
    );
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  }

  it('installed: ok, trust n/a', () => {
    claudeHome({});
    recordHookRun('Stop', 'claude', NOW - 30_000);
    const row = hookRow(claudeHooks(opts()), NOW);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('Stop: installed, trust n/a, last run 30s ago');
    expect(row.detail).toContain('SessionStart: installed, trust n/a, never run');
  });

  it('a disabled plugin or disableAllHooks fails the row with the step', () => {
    claudeHome({ enabledPlugins: { 'lobstah@lobstah': false } });
    expect(hookRow(claudeHooks(opts()), NOW).detail).toContain('In Claude Code, enable the lobstah plugin (/plugin)');
    claudeHome({ disableAllHooks: true });
    const row = hookRow(claudeHooks(opts()), NOW);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('disableAllHooks');
  });
});

describe('hook runs', () => {
  it('a hook run is stamped by harness and event, throttled; other events are not', () => {
    recordHookRun('Stop', 'codex', NOW);
    recordHookRun('Stop', 'codex', NOW + 10_000);
    recordHookRun('UserPromptSubmit', 'codex', NOW);
    expect(readHookRuns()).toEqual({ 'codex:Stop': new Date(NOW).toISOString() });
    recordHookRun('Stop', 'codex', NOW + 60_000);
    expect(readHookRuns()['codex:Stop']).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('the hook commands stamp their run from the hook input', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
    // A Codex thread id is a UUIDv7.
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: '01a0ceb8-b9bd-7d42-927c-c52a334b8e2d', cwd: dir, tool_name: 'Bash' });
    const res = spawnSync(process.execPath, [cli, 'soak', 'beat'], { input, env: { ...env, LOBSTAH_HOME: process.env.LOBSTAH_HOME }, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(Object.keys(readHookRuns())).toEqual(['codex:PostToolUse']);
  });
});

describe('doctor: listeners', () => {
  it('a signed-on trap that is not parked and has no catch is not listening', () => {
    const signed = signOnTrap({ sessionId: '01a0ceb8-b9bd-7d42-927c-c52a334b8e2d', harness: 'codex', repo: 'web', worktree: dir, cwd: dir, ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('unexpected hold');
    const row = listenerRow(Date.now());
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/trap .*: not listening — no automatic wake reaches trap /);
  });

  it('nothing signed on: skip', () => {
    expect(listenerRow().status).toBe('skip');
  });
});
