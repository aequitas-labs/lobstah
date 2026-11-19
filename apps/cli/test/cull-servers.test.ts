import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout, loadConfig } from '@lobstah/core';
import { busyServerWorktrees, formatServerCull, latestWorktreeEdit, planServerCull, runServerCull, serverWorktree, serverWorktreeRoots, type ServerCullOptions } from '../src/cull-servers.js';
import { parseServerProcesses, parseWorktreeContainers, type ServerInventory, type ServerProcess, type ServerRuntime } from '../src/cull-server-inventory.js';
import { runCullWithServers } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let worktree: string;
let external: string;
let options: ServerCullOptions;
const now = Date.parse('2026-11-18T12:00:00Z');
const startedAt = 'Mon Nov 16 12:00:00 2026';
const HOUR = 3_600_000;

function server(overrides: Partial<ServerProcess> = {}): ServerProcess {
  return { pid: 700001, parentPid: 1, groupId: 700001, startedAt, command: 'node node_modules/next/dist/bin/next dev', cwd: worktree, ports: [3000], ...overrides };
}
function inventory(processes: ServerProcess[] = [server()]): ServerInventory {
  return { processes, containers: [], panes: [], warnings: [] };
}
function fakeRuntime(initial: ServerInventory): ServerRuntime {
  return { inspect: vi.fn(() => initial), signal: vi.fn(), stopContainer: vi.fn(), closeSession: vi.fn(), wait: vi.fn(async () => {}) };
}
function container(bindSources: string[] = [worktree]) {
  return { id: 'a'.repeat(64), name: 'app-postgres-1', startedAt: '2026-11-16T12:00:00Z', bindSources, ports: [5432] };
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cull-servers-')));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  worktree = path.join(home, 'worktrees/old');
  external = path.join(home, 'agents/old');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  options = { now, roots: [{ directory: path.join(home, 'worktrees'), lobstah: true }, { directory: path.join(home, 'agents'), lobstah: false }], busyWorktrees: () => [], lastEdit: () => now - 24 * HOUR };
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('server inventory parsers', () => {
  it('joins portable ps and lsof fields, retaining spaces, IPv6 and deduplicated ports', () => {
    const rows = parseServerProcesses(
      `700001 1 700001 ${startedAt} node next dev\n700002 1 700002 ${startedAt} codex`,
      `p700001\nn${worktree}/folder with spaces\np700002\nn${worktree}`,
      'p700001\nn*:3000\nn[::1]:3000\nn127.0.0.1:3001\np700002\nn127.0.0.1:9999',
    );
    expect(rows[0]).toMatchObject({ pid: 700001, groupId: 700001, startedAt, cwd: `${worktree}/folder with spaces`, ports: [3000, 3001] });
    expect(rows[1]?.ports).toEqual([9999]);
  });

  it('reads only running containers and host bind mounts, including Compose labels', () => {
    const rows = parseWorktreeContainers(JSON.stringify([
      { Id: 'app', Name: '/app-db', State: { Running: true, StartedAt: '2026-11-16T12:00:00Z' }, Config: { Labels: { 'com.docker.compose.project.working_dir': worktree } }, Mounts: [{ Type: 'bind', Source: external }, { Type: 'volume', Source: '/var/lib/docker/volumes/db' }], NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5432' }] } } },
      { Id: 'stopped', State: { Running: false } },
    ]));
    expect(rows).toEqual([{ id: 'app', name: 'app-db', startedAt: '2026-11-16T12:00:00Z', workingDirectory: worktree, bindSources: [external], ports: [5432] }]);
  });
});

describe('worktree scope and idle gates', () => {
  it('includes the default roots and additional configured roots', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.app]\npath = ${JSON.stringify(path.join(home, 'repo'))}\n[cull]\nworktreeRoots = [${JSON.stringify(path.join(home, 'agents'))}]\n`);
    expect(serverWorktreeRoots().map((root) => root.directory)).toEqual([
      path.join(home, 'worktrees'), path.join(os.homedir(), '.codex/worktrees'), path.join(home, 'repo/.claude/worktrees'), path.join(home, 'agents'),
    ]);
  });

  it('validates root configuration and the idle-hours flag', () => {
    for (const raw of ['[42]', '["relative/path"]', '"oops"']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[cull]\nworktreeRoots = ${raw}\n`);
      expect(() => loadConfig()).toThrow('worktreeRoots');
    }
    for (const idleHours of [-1, NaN, Infinity]) expect(() => planServerCull(inventory(), { ...options, idleHours })).toThrow('--idle-hours');
  });

  it('rejects parent directories, prefix collisions and symlink escapes', () => {
    const outside = path.join(home, 'personal'); fs.mkdirSync(outside);
    expect(serverWorktree(path.dirname(worktree), options.roots!)).toBeUndefined();
    expect(serverWorktree(path.join(home, 'worktrees-personal/app'), options.roots!)).toBeUndefined();
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(home, 'worktrees/escape'));
      expect(serverWorktree(path.join(home, 'worktrees/escape'), options.roots!)).toBeUndefined();
    }
    expect(planServerCull(inventory([server({ cwd: outside })]), options)).toEqual([]);
  });

  it('locates nested Codex checkouts from a linked-worktree .git file', () => {
    const nested = path.join(external, 'repo'); fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, '.git'), 'gitdir: /fixture');
    fs.mkdirSync(path.join(nested, 'src'));
    expect(serverWorktree(path.join(nested, 'src'), options.roots!)).toEqual({ directory: nested, lobstah: false });
  });

  it('keeps busy checkouts and freshly edited external worktrees with a reason', () => {
    expect(planServerCull(inventory(), { ...options, busyWorktrees: () => [worktree] })[0]).toMatchObject({ action: 'keep', reason: 'worktree is busy' });
    const externalInventory = inventory([server({ cwd: external })]);
    expect(planServerCull(externalInventory, { ...options, lastEdit: () => now - HOUR })[0]).toMatchObject({ reason: 'edited within 12h' });
    expect(planServerCull(externalInventory, { ...options, lastEdit: () => now - HOUR, idleHours: 0.5 })[0]?.action).toBe('stop');
    expect(planServerCull(externalInventory, { ...options, lastEdit: () => { throw new Error('denied'); } })[0]?.reason).toBe('could not read worktree edits');
    expect(planServerCull(inventory(), { ...options, lastEdit: () => now })[0]?.action).toBe('stop');
  });

  it('sees edits below the checkout without following symlinks', () => {
    fs.mkdirSync(path.join(external, 'src')); fs.writeFileSync(path.join(external, 'src/new.ts'), 'new');
    expect(latestWorktreeEdit(external)).toBeGreaterThan(Date.now() - 60_000);
    if (process.platform !== 'win32') fs.symlinkSync(external, path.join(external, 'loop'));
    expect(() => latestWorktreeEdit(external)).not.toThrow();
  });

  it('uses soaking claims and status, ignoring historical roster liveness', () => {
    fs.writeFileSync(path.join(home, 'soaking/test.json'), JSON.stringify({ trapId: 'test', worktree, claimed: 'catch' }));
    expect(busyServerWorktrees()).toEqual([worktree]);
    fs.mkdirSync(path.join(home, 'active/catch'));
    appendStatus('catch', 'work', 'working');
    expect(busyServerWorktrees()).toEqual([worktree]);
    appendStatus('catch', 'work', 'paused');
    expect(busyServerWorktrees()).toEqual([]);
    fs.writeFileSync(path.join(home, 'soaking/test.json'), JSON.stringify({ trapId: 'test', worktree, parkedAt: new Date(now).toISOString() }));
    expect(busyServerWorktrees()).toEqual([]);
    fs.rmSync(path.join(home, 'soaking/test.json'));
    fs.mkdirSync(path.join(home, 'roster'));
    fs.writeFileSync(path.join(home, 'roster/test.json'), JSON.stringify({ trapId: 'test', worktree, state: 'live' }));
    expect(busyServerWorktrees()).toEqual([]);
  });

  it('keeps active headless runners in their recorded checkout and fails closed on corrupt traps', () => {
    fs.mkdirSync(path.join(home, 'active/headless'));
    fs.writeFileSync(path.join(home, 'active/headless/worktree.json'), JSON.stringify({ path: worktree }));
    expect(busyServerWorktrees()).toEqual([worktree]);
    fs.writeFileSync(path.join(home, 'soaking/broken.json'), '{');
    expect(() => busyServerWorktrees()).toThrow();
  });
});

describe('server cleanup safety', () => {
  it('plans listeners and dedicated groups, omitting non-listening watchers', () => {
    const rows = planServerCull(inventory([server(), server({ pid: 700002, parentPid: 700001, ports: [] }), server({ pid: 700003, groupId: 700003, ports: [] })]), options);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId: 700001, action: 'stop', ageHours: 48 });
    expect(rows[0]?.processes.map((row) => row.pid)).toEqual([700001, 700002]);
  });

  it.each(['codex --listen', 'claude --listen', 'node /tools/@openai/codex/bin/codex.js', 'lobstah glass', 'node dist/main.js daemon', 'dockerd', 'com.docker.backend', 'tmux'])('keeps protected command %s', (command) => {
    expect(planServerCull(inventory([server({ command })]), options)[0]).toMatchObject({ action: 'keep', reason: 'agent or infrastructure process' });
  });

  it('stops only the listener when its group contains an agent or an unrelated cwd', async () => {
    for (const other of [server({ pid: 700002, ports: [], command: 'codex' }), server({ pid: 700002, ports: [], cwd: home })]) {
      const runtime = fakeRuntime(inventory([server(), other]));
      await runServerCull(true, options, runtime);
      expect(runtime.signal).toHaveBeenNthCalledWith(1, 700001, 'SIGTERM');
      expect(runtime.signal).toHaveBeenNthCalledWith(2, 700001, 'SIGKILL');
    }
  });

  it('protects recorded harness pids even when their command name is unfamiliar', () => {
    expect(planServerCull(inventory(), { ...options, protectedPids: [700001] })[0]?.reason).toBe('agent or infrastructure process');
  });

  it('dry run shows ports, pid, worktree, age and actions without effects', async () => {
    const initial = inventory(); initial.containers = [container()];
    const runtime = fakeRuntime(initial);
    const output = await runServerCull(false, options, runtime);
    expect(output).toContain('kind,id,port,pid,worktree,ageHours,action');
    expect(output).toContain(`server,700001,3000,700001,${worktree},48,stop`);
    expect(output).toContain('5432'); expect(output).toContain('dry run');
    expect(runtime.signal).not.toHaveBeenCalled(); expect(runtime.stopContainer).not.toHaveBeenCalled(); expect(runtime.closeSession).not.toHaveBeenCalled(); expect(runtime.wait).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and escalates surviving original group members after the grace period', async () => {
    const runtime = fakeRuntime(inventory());
    const output = await runServerCull(true, options, runtime);
    expect(runtime.signal).toHaveBeenNthCalledWith(1, -700001, 'SIGTERM');
    expect(runtime.wait).toHaveBeenCalledWith(5000);
    expect(runtime.signal).toHaveBeenNthCalledWith(2, -700001, 'SIGKILL');
    expect(output).toContain('SIGTERM, SIGKILL');
  });

  it('does not escalate a process that exited during the grace period', async () => {
    const runtime = fakeRuntime(inventory());
    runtime.wait = vi.fn(async () => { runtime.inspect = () => inventory([]); });
    await runServerCull(true, options, runtime);
    expect(runtime.signal).toHaveBeenCalledTimes(1);
  });

  it('rejects PID reuse, new group members, cwd changes and newly busy worktrees', async () => {
    const changed = [inventory([server({ startedAt: 'Tue Nov 17 12:00:00 2026' })]), inventory([server(), server({ pid: 700002, ports: [], command: 'claude' })]), inventory([server({ cwd: home })])];
    for (const current of changed) {
      const runtime = fakeRuntime(inventory());
      runtime.inspect = vi.fn().mockReturnValueOnce(inventory()).mockReturnValue(current);
      expect(await runServerCull(true, options, runtime)).toContain('changed since inspection');
      expect(runtime.signal).not.toHaveBeenCalled();
    }
    let reads = 0;
    const runtime = fakeRuntime(inventory());
    await runServerCull(true, { ...options, busyWorktrees: () => ++reads === 1 ? [] : [worktree] }, runtime);
    expect(runtime.signal).not.toHaveBeenCalled();
  });

  it('does not SIGKILL a new group member or reused PID after SIGTERM', async () => {
    const runtime = fakeRuntime(inventory());
    runtime.wait = vi.fn(async () => { runtime.inspect = () => inventory([server({ startedAt: 'Tue Nov 17 12:00:00 2026' })]); });
    await runServerCull(true, options, runtime);
    expect(runtime.signal).toHaveBeenCalledTimes(1);
  });
});

describe('container and tmux cleanup', () => {
  it('scopes Compose projects or bind mounts; keeps mixed busy mounts and infrastructure', async () => {
    const initial = inventory([]);
    initial.containers = [container(), { ...container([]), id: 'compose', workingDirectory: external }, { ...container([home]), id: 'personal' }, { ...container([worktree, external]), id: 'mixed' }, { ...container(), id: 'glass', name: 'lobstah-glass' }];
    const rows = planServerCull(initial, { ...options, busyWorktrees: () => [external] });
    expect(rows.map((row) => row.id)).not.toContain('personal');
    expect(rows.find((row) => row.id === 'mixed')?.reason).toBe('worktree is busy');
    expect(rows.find((row) => row.id === 'glass')?.reason).toBe('infrastructure container');
    const runtime = fakeRuntime(initial);
    await runServerCull(true, { ...options, busyWorktrees: () => [external] }, runtime);
    expect(runtime.stopContainer).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 5);
  });

  it('rechecks container start identity and worktree activity', async () => {
    const initial = inventory([]); initial.containers = [container()];
    const restarted = inventory([]); restarted.containers = [{ ...container(), startedAt: '2026-11-18T11:00:00Z' }];
    const runtime = fakeRuntime(initial);
    runtime.inspect = vi.fn().mockReturnValueOnce(initial).mockReturnValue(restarted);
    expect(await runServerCull(true, options, runtime)).toContain('container changed');
    expect(runtime.stopContainer).not.toHaveBeenCalled();
  });

  it('closes only dedicated server tmux sessions, preserving agent sessions', async () => {
    const shell = server({ pid: 700010, groupId: 700010, ports: [], command: 'zsh' });
    const listener = server({ parentPid: shell.pid });
    const initial = inventory([shell, listener]); initial.panes = [{ session: '$1', pid: shell.pid }];
    expect(planServerCull(initial, options).some((row) => row.kind === 'tmux')).toBe(true);
    const runtime = fakeRuntime(initial);
    runtime.wait = vi.fn(async () => { runtime.inspect = () => ({ ...initial, processes: [shell] }); });
    await runServerCull(true, options, runtime);
    expect(runtime.closeSession).toHaveBeenCalledExactlyOnceWith('$1');
    initial.processes.push(server({ pid: 700020, parentPid: shell.pid, groupId: 700020, command: 'claude', ports: [] }));
    expect(planServerCull(initial, options).some((row) => row.kind === 'tmux')).toBe(false);
  });

  it('keeps a tmux session that gained an agent or another pane during the grace period', async () => {
    const shell = server({ pid: 700010, groupId: 700010, ports: [], command: 'zsh' });
    const initial = inventory([shell, server({ parentPid: shell.pid })]); initial.panes = [{ session: '$1', pid: shell.pid }];
    const runtime = fakeRuntime(initial);
    runtime.wait = vi.fn(async () => { runtime.inspect = () => ({ ...initial, processes: [...initial.processes, server({ pid: 700020, parentPid: shell.pid, command: 'codex', ports: [] })] }); });
    expect(await runServerCull(true, options, runtime)).toContain('session or worktree changed');
    expect(runtime.closeSession).not.toHaveBeenCalled();
  });

  it('prints inventory failures and stop failures without claiming success', async () => {
    const initial = inventory(); initial.warnings = ['Could not inspect Docker containers; containers kept.'];
    const runtime = fakeRuntime(initial); runtime.signal = vi.fn(() => { throw new Error('denied'); });
    const output = await runServerCull(true, options, runtime);
    expect(output).toContain('could not send SIGTERM'); expect(output).toContain(initial.warnings[0]);
  });

  it('includes the service pass in manual cull even when the disk plan is empty', async () => {
    const runtime = fakeRuntime(inventory());
    const output = await runCullWithServers(14, false, options, runtime);
    expect(output).toContain('servers['); expect(output).toContain('cull[');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
});
