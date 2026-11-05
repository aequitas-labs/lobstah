import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfiguredTraps, withConfiguredTrapSlot, configuredTrapSlots, signOnTrap, stowTrap, readRoster, forgetRoster, claimBait, daemonSkip, enqueue, ensureLayout, pendingIds, heartbeatTrap, sweepGhostTraps, baitBrief, type ConfiguredTrapProfile, type Descriptor, type TrapRegistration } from '../src/index.js';

let home: string;
const profile: ConfiguredTrapProfile = { harness: 'claude', surface: 'terminal', grounds: 'fleet', maxInstances: 1 };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-configured-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[traps.desk]\nharness="claude"\nsurface="terminal"\ngrounds="fleet"\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; fs.rmSync(home, { recursive: true, force: true }); });

function signOn(sessionId: string, selected: ConfiguredTrapProfile = profile): TrapRegistration {
  return withConfiguredTrapSlot('desk', selected, sessionId, (slot) => {
    const result = signOnTrap({ worktree: slot.cwd, cwd: slot.cwd, trapId: slot.trapId, configured: slot, harness: selected.harness, sessionId, ttlMs: 60_000 });
    if ('held' in result) throw new Error('held');
    return result.ok;
  });
}
function dispatch(overrides: Partial<Descriptor> = {}): Descriptor {
  return { id: 'desk-task', brief: 'Inspect the scratch window', for: 'trap:desk', target: { kind: 'configured-trap', profile: 'desk', grounds: 'fleet', surface: 'terminal' }, ...overrides };
}

describe('configured trap profiles', () => {
  it('validates keys, grounds, harness, surface, folder and cap before any allocation', () => {
    expect(parseConfiguredTraps({ desk: profile }, {})).toEqual({ desk: profile });
    for (const change of [{ unknown: true }, { grounds: 'missing' }, { harness: 'other' }, { harness: 'codex', surface: 'claude-desktop' }, { surface: 'claude-desktop', terminal: 'tmux' }, { maxInstances: 0 }, { cwd: '../repo' }, { cwd: path.join(home, 'absent') }]) {
      expect(() => parseConfiguredTraps({ desk: { ...profile, ...change } }, {})).toThrow(/\[traps.desk\]/);
    }
    expect(parseConfiguredTraps({ desk: { ...profile, grounds: 'home' } }, {}).desk.grounds).toBe('fleet');
    expect(configuredTrapSlots()).toEqual([]);
  });

  it('keeps the same slot across stow and ghost without touching git or deleting a supplied folder', () => {
    const cwd = path.join(home, 'plain-folder'); fs.mkdirSync(cwd);
    execFileSync('git', ['init', '-q', cwd]);
    fs.writeFileSync(path.join(cwd, 'keep.txt'), 'keep');
    const first = signOn('one', { ...profile, cwd });
    expect(fs.existsSync(path.join(cwd, '.lobstah-trap'))).toBe(false);
    stowTrap(first.trapId);
    const returned = signOn('two', { ...profile, cwd });
    expect(returned.trapId).toBe(first.trapId);
    heartbeatTrap(returned.trapId, { parked: true });
    sweepGhostTraps(1000, Date.now() + 10_000);
    expect(readRoster(first.trapId)?.state).toBe('ghosted');
    expect(execFileSync('git', ['-C', cwd, 'for-each-ref'], { encoding: 'utf8' })).toBe('');
    forgetRoster(first.trapId);
    expect(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8')).toBe('keep');
    expect(configuredTrapSlots()).toEqual([]);
  });

  it('enforces a profile cap on manual sign-on, while repeated sign-on reuses its instance', () => {
    const first = signOn('one');
    expect(signOn('one').trapId).toBe(first.trapId);
    expect(() => signOn('two')).toThrow(/1\/1/);
    expect(configuredTrapSlots()).toHaveLength(1);
    expect(signOn('two', { ...profile, maxInstances: 2 }).trapId).not.toBe(first.trapId);
  });

  it('keeps configured bait sticky, scoped to its profile and grounds, and out of the headless queue', () => {
    const reg = signOn('one');
    const descriptor = dispatch();
    enqueue(descriptor);
    expect(daemonSkip([], 0)(descriptor)).toBe(true);
    expect(claimBait({ ...reg, configured: { ...reg.configured!, grounds: 'another' } })).toBeNull();
    expect(claimBait({ ...reg, configured: undefined, repo: 'some-repo' })).toBeNull();
    expect(pendingIds('work')).toEqual(['desk-task']);
    expect(claimBait(reg)?.id).toBe('desk-task');
    expect(baitBrief('desk-task', descriptor)).not.toContain('fresh branch');
    expect(baitBrief('desk-task', descriptor)).not.toContain('--pr');
  });

  it('rejects repo and PR metadata before enqueueing a configured dispatch', () => {
    for (const extra of [{ repo: 'repo' }, { pool: 'pool' }, { trapAny: true }, { pr: { url: 'https://github.com/a/b/pull/1' } }, { followUp: 'parent' }]) expect(() => enqueue(dispatch(extra))).toThrow(/configured trap/);
    expect(pendingIds('work')).toEqual([]);
  });
});

it('uses the configured session identity when its plain folder contains another repo trap anchor', async () => {
  const { beatTrap, readTrapAnchor } = await import('../src/index.js');
  const cwd = path.join(home, 'shared-folder'); fs.mkdirSync(cwd);
  const anchored = signOnTrap({ worktree: cwd, cwd, sessionId: 'repo-worker', harness: 'claude', repo: 'repo', ttlMs: 60_000 });
  if ('held' in anchored) throw new Error('held');
  const configured = signOn('desk-worker', { ...profile, cwd });
  expect(beatTrap({ cwd, sessionId: 'desk-worker' }).trapId).toBe(configured.trapId);
  expect(readTrapAnchor(cwd)?.trapId).toBe(anchored.ok.trapId);
});
