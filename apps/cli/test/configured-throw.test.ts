import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestDesktopStart, ensureLayout, loadConfig, configuredTrapSlots, signOnTrap, heartbeatTrap, standingDecisions, enqueue, claimBait, stowTrap, withConfiguredTrapSlot } from '@lobstah/core';
import { parse } from 'smol-toml';
import { listCodexHooks } from '../src/codex-hook-list.js';
import { throwConfiguredTrap } from '../src/configured-throw.js';
import type { TerminalLaunch } from '../src/throw.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
vi.mock('../src/codex-hook-list.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/codex-hook-list.js')>(), listCodexHooks: vi.fn(async () => undefined) }));
let home: string;
let previousCodexHome: string | undefined;
beforeEach(() => {
  vi.mocked(listCodexHooks).mockResolvedValue(undefined);
  previousCodexHome = process.env.CODEX_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-configured-throw-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  process.env.CODEX_HOME = path.join(home, 'codex-home');
  fs.mkdirSync(process.env.CODEX_HOME);
  fs.writeFileSync(path.join(home, 'config.toml'), '[traps.desk]\nharness="claude"\nsurface="claude-desktop"\ngrounds="fleet"\n[traps.ops]\nharness="codex"\nsurface="terminal"\ngrounds="fleet"\nterminal="tmux"\n');
});
afterEach(() => { if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; delete process.env.LOBSTAH_HOME; fs.rmSync(home, { recursive: true, force: true }); });

it('returns a concrete app-start card for a desktop and never launches its terminal adapter', async () => {
  let launches = 0;
  const result = await throwConfiguredTrap(loadConfig(), 'desk', 'helm', { adapter: { app: 'tmux', async launch() { launches++; } } });
  expect(result.state).toBe('needs-app-start'); expect(launches).toBe(0);
  expect(standingDecisions()).toHaveLength(1);
});

it('starts a terminal profile in its plain folder with the normal global reviewer mode, and observes its first park', async () => {
  let command: TerminalLaunch | undefined;
  const result = await throwConfiguredTrap(loadConfig(), 'ops', 'helm', { timeoutSecs: 1, pollMs: 1, adapter: { app: 'tmux', async launch(launch) {
    command = launch;
    const slot = configuredTrapSlots('ops')[0]!;
    const signed = signOnTrap({ worktree: slot.cwd, cwd: slot.cwd, configured: slot, trapId: slot.trapId, harness: 'codex', sessionId: 'new-codex-session', ttlMs: 60_000 });
    if ('held' in signed) throw new Error('held'); heartbeatTrap(signed.ok.trapId, { parked: true });
  } } });
  expect(result.state).toBe('listening');
  expect(command?.cwd).toContain('trap-workspaces');
  expect(command?.argv).toContain('approvals_reviewer="auto_review"');
  expect(command?.argv.at(-1)).toContain('soak --trap ops');
  expect(fs.existsSync(path.join(command!.cwd, '.lobstah-trap'))).toBe(false);
});

it('leaves configured desktop tool approvals to the harness without filing a glass card', () => {
  const { slot } = requestDesktopStart(loadConfig(), 'desk', 'helm');
  const signed = signOnTrap({ worktree: slot.cwd, cwd: slot.cwd, configured: slot, trapId: slot.trapId, harness: 'claude', sessionId: 'desktop-session', ttlMs: 60_000 });
  if ('held' in signed) throw new Error('held');
  heartbeatTrap(signed.ok.trapId, { parked: true });
  enqueue({ id: 'inspection', brief: 'Inspect a window', for: 'trap:desk', target: { kind: 'configured-trap', profile: 'desk', grounds: 'fleet', surface: 'claude-desktop' } });
  expect(claimBait(signed.ok)?.id).toBe('inspection');
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const response = spawnSync(process.execPath, [cli, 'hook', 'permission-request'], { cwd: home, env: { ...process.env, LOBSTAH_HOME: home }, encoding: 'utf8', input: JSON.stringify({ session_id: 'desktop-session', cwd: slot.cwd, tool_name: 'Bash', tool_input: { command: 'inspect-placeholder' } }), timeout: 15_000 });
  expect(response.status).toBe(0); expect(response.stdout).toBe(''); expect(response.stderr).toBe('');
  expect(standingDecisions()).toEqual([]);
});

it('forgets a never-signed-on instance only after its start card is withdrawn, keeping its folder', async () => {
  const { withdrawDecision } = await import('@lobstah/core');
  const { forgetTrap } = await import('../src/forget.js');
  const start = requestDesktopStart(loadConfig(), 'desk', 'helm');
  await expect(forgetTrap('trap:desk', loadConfig())).rejects.toThrow('pending app start');
  withdrawDecision(start.card.key);
  await forgetTrap('trap:desk', loadConfig());
  expect(configuredTrapSlots('desk')).toEqual([]);
  expect(fs.existsSync(start.slot.cwd)).toBe(true);
  expect(loadConfig().traps?.desk).toBeDefined();
});

it('preserves explicit Codex folder distrust without editing the user configuration', async () => {
  const codexHome = process.env.CODEX_HOME!;
  const configFile = path.join(codexHome, 'config.toml'), contents = `[projects.${JSON.stringify(home)}]\ntrust_level="untrusted"\n`;
  fs.writeFileSync(configFile, contents);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = codexHome;
  let command: TerminalLaunch | undefined;
  try {
    await throwConfiguredTrap(loadConfig(), 'ops', 'helm', { timeoutSecs: 0.001, adapter: { app: 'tmux', async launch(launch) { command = launch; } } });
    expect(command?.argv.some((argument) => argument.startsWith('projects='))).toBe(false);
    expect(command?.argv).toContain('check_for_update_on_startup=false');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(contents);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});


it('uses Codex-reported plugin content hashes without trusting other listed hooks', async () => {
  const codexHome = process.env.CODEX_HOME!;
  const plugin = path.join(codexHome, 'plugins', 'cache', 'lobstah', 'lobstah', '0.8.4');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hooks'));
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), '{"name":"lobstah","version":"0.8.4"}');
  fs.copyFileSync(new URL('../../../plugins/codex/hooks/hooks.json', import.meta.url), path.join(plugin, 'hooks', 'hooks.json'));
  const configFile = path.join(codexHome, 'config.toml');
  const contents = '[plugins."lobstah@lobstah"]\nenabled=true\n';
  fs.writeFileSync(configFile, contents);
  const key = 'lobstah@lobstah:hooks/hooks.json:stop:0:0';
  vi.mocked(listCodexHooks).mockResolvedValue(new Map([
    [key, { key, command: 'lobstah hook stop', currentHash: 'sha256:hook/sha256:plugin', trustStatus: 'modified' }],
    ['other:stop', { key: 'other:stop', command: 'other hook', currentHash: 'sha256:other', trustStatus: 'untrusted' }],
  ]));
  let command: TerminalLaunch | undefined;
  await throwConfiguredTrap(loadConfig(), 'ops', 'helm', { timeoutSecs: 0.001, adapter: { app: 'tmux', async launch(launch) { command = launch; } } });
  const override = command!.argv.find(argument => argument.startsWith('hooks.state='))!;
  const state = (parse(override) as { hooks: { state: Record<string, Record<string, string>> } }).hooks.state;
  expect(state[key]).toEqual({ trusted_hash: 'sha256:hook', trusted_content_hash: 'sha256:plugin' });
  expect(Object.keys(state).every(hook => hook.startsWith('lobstah@lobstah:'))).toBe(true);
  expect(listCodexHooks).toHaveBeenCalledWith(command!.cwd);
  expect(fs.readFileSync(configFile, 'utf8')).toBe(contents);
});

it('refuses a live session held by another trap and starts cold after a stale duplicate claim', async () => {
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[traps.other]\nharness="codex"\nsurface="terminal"\ngrounds="fleet"\n');
  const config = loadConfig();
  const savedSession = 'configured-session-claimed-elsewhere';
  const original = withConfiguredTrapSlot('ops', config.traps!.ops!, undefined, slot => slot);
  const signOn = (slot: typeof original) => {
    const result = signOnTrap({ worktree: slot.cwd, cwd: slot.cwd, configured: slot, trapId: slot.trapId, harness: 'codex', sessionId: savedSession, ttlMs: 60_000 });
    if ('held' in result) throw new Error('unexpected hold');
    return result.ok;
  };
  const first = signOn(original);
  stowTrap(first.trapId);
  const other = withConfiguredTrapSlot('other', config.traps!.other!, undefined, slot => slot);
  const second = signOn(other);
  // Reproduce a persisted duplicate from before the roster ownership repair.
  const rosterFile = path.join(home, 'roster', `${original.trapId}.json`);
  fs.writeFileSync(rosterFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(rosterFile, 'utf8')), sessionId: savedSession }));
  const launches: TerminalLaunch[] = [];
  const options = { timeoutSecs: 0.001, adapter: { app: 'tmux' as const, async launch(command: TerminalLaunch) { launches.push(command); } } };
  await expect(throwConfiguredTrap(config, 'ops', 'helm', options)).rejects.toThrow(/not starting trap:ops/);
  expect(launches).toEqual([]);
  stowTrap(second.trapId);
  await throwConfiguredTrap(config, 'ops', 'helm', options);
  expect(launches).toHaveLength(1);
  expect(launches[0]!.argv).not.toContain('resume');
  expect(launches[0]!.argv).not.toContain(savedSession);
});
