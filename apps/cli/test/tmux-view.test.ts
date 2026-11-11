import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, shellQuote } from '@lobstah/core';
import type { Config } from '@lobstah/core';
import { openTmuxPane, tmuxRunner } from '../src/tmux-terminal.js';
import type { TmuxRunner } from '../src/tmux-terminal.js';
import { openTmuxView, tmuxViewCommand } from '../src/tmux-view.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tmux-view-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const REPOS = '[repos.web]\npath = "/w"\n[repos.api]\npath = "/a"\n[repos.ops]\npath = "/o"\n';
const config = (toml: string): Config => {
  fs.writeFileSync(path.join(home, 'config.toml'), toml);
  return loadConfig();
};

/** A tmux server holding these windows, or none, that records what it is asked. */
const server = (windows?: { id: string; name: string; panes?: string[] }[]) => {
  const seen: string[][] = [];
  const run: TmuxRunner = async (args) => {
    seen.push(args);
    if (!windows) throw new Error('no server running');
    if (args[0] === 'list-windows') return windows.map((w) => `${w.id}|${w.name}|1\n`).join('');
    if (args[0] === 'list-panes') return windows.flatMap((w) => (w.panes ?? []).map((p) => `${w.id} ${p}\n`)).join('');
    throw new Error(`unexpected tmux ${args[0]}`);
  };
  return { seen, run };
};
const WINDOWS = [{ id: '@4', name: 'api' }, { id: '@7', name: 'web' }];
/** Opens a view on this macOS machine and records the shell text its Terminal window runs. */
const onMac = () => {
  const opened: string[] = [];
  return { opened, options: { platform: 'darwin' as const, env: {}, openWindow: async (text: string) => { opened.push(text); } } };
};

describe('lobstah tmux', () => {
  it("opens a Terminal window on a new view of the repo's window, or the first with no repo", async () => {
    const cfg = config(REPOS);
    const onRepo = onMac();
    const result = await openTmuxView(cfg, 'web', { run: server(WINDOWS).run, ...onRepo.options });
    expect(result).toMatchObject({ opened: true, window: 'web' });
    const view = result.opened ? result.view : '';
    expect(onRepo.opened).toEqual([`exec ${tmuxViewCommand(view, '@7').map(shellQuote).join(' ')}`]);
    const first = onMac();
    expect(await openTmuxView(cfg, undefined, { run: server(WINDOWS).run, ...first.options })).toMatchObject({ opened: true, window: 'api' });
    expect(first.opened[0]).toContain(':@4');
  });

  it("finds the repo's window when paging by grounds, and by its traps on fixed pages", async () => {
    const byGrounds = config(`${REPOS}[grounds.product]\nrepos = ["web", "api"]\n[soak]\ntmuxPages = "grounds"\n`);
    const grounds = onMac();
    expect(await openTmuxView(byGrounds, 'web', { run: server([{ id: '@1', name: 'home' }, { id: '@2', name: 'product' }]).run, ...grounds.options })).toMatchObject({ window: 'product' });

    const fixed = config(`${REPOS}[soak]\ntmuxPages = "fixed"\n`);
    fs.mkdirSync(path.join(home, 'soaking'), { recursive: true });
    fs.writeFileSync(path.join(home, 'soaking', 'aaaa.json'), JSON.stringify({ trapId: 'aaaa', repo: 'web', window: { tmuxPane: '%5', tmuxSocket: '/tmp/tmux-501/lobstah' } }));
    fs.writeFileSync(path.join(home, 'soaking', 'bbbb.json'), JSON.stringify({ trapId: 'bbbb', repo: 'web', window: { tmuxPane: '%1', tmuxSocket: '/tmp/tmux-501/default' } }));
    const pages = [{ id: '@1', name: 'page-1', panes: ['%1'] }, { id: '@2', name: 'page-2', panes: ['%5'] }];
    expect(await openTmuxView(fixed, 'web', { run: server(pages).run, ...onMac().options })).toMatchObject({ window: 'page-2' });
    await expect(openTmuxView(fixed, 'api', { run: server(pages).run, ...onMac().options })).rejects.toThrow('repo "api" has no tmux window. Windows now: page-1, page-2');
  });

  it('says so when there is no trap session, the repo has no window, or the repo is unknown, opening nothing', async () => {
    const cfg = config(REPOS);
    const mac = onMac();
    const none = server();
    await expect(openTmuxView(cfg, undefined, { run: none.run, ...mac.options })).rejects.toThrow(/no trap session to show.*terminal = "tmux"/);
    expect(none.seen.map((a) => a[0])).toEqual(['list-windows']);
    await expect(openTmuxView(cfg, 'ops', { run: server(WINDOWS).run, ...mac.options })).rejects.toThrow('repo "ops" has no tmux window. Windows now: api, web');
    await expect(openTmuxView(cfg, 'nope', { run: server(WINDOWS).run, ...mac.options })).rejects.toThrow('no repo "nope" is configured');
    expect(mac.opened).toEqual([]);
  });

  it('prints the command to run from inside tmux and off macOS', async () => {
    const cfg = config(REPOS);
    const mac = onMac();
    const inside = await openTmuxView(cfg, 'web', { run: server(WINDOWS).run, ...mac.options, env: { TMUX: '/tmp/tmux-501/default,1,0' } });
    expect(inside).toMatchObject({ opened: false, reason: expect.stringContaining('outside') });
    expect(!inside.opened && inside.attach).toMatch(/^tmux -N -L lobstah has-session -t '=lobstah' ';' new-session .*:@7'$/);
    const linux = await openTmuxView(cfg, 'web', { run: server(WINDOWS).run, ...mac.options, platform: 'linux' });
    expect(linux).toMatchObject({ opened: false, reason: expect.stringContaining('macOS') });
    expect(mac.opened).toEqual([]);
  });

  it('quotes a leading = so zsh does not read it as a command path', () => {
    expect(shellQuote('=lobstah')).toBe("'=lobstah'");
    expect(shellQuote('a=b')).toBe('a=b');
  });
});

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)('views on a real tmux server', () => {
  const socket = `lobstah-view-test-${process.pid}`;
  const clients: ChildProcess[] = [];
  let socketPath: string | undefined;
  afterEach(() => {
    for (const client of clients.splice(0)) client.kill();
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    if (socketPath) fs.rmSync(socketPath, { force: true });
  });

  /** A real client on a view's command: a control-mode client lives until its stdin closes. */
  const attach = (view: string, windowId: string): ChildProcess => {
    const [tmux, ...args] = tmuxViewCommand(view, windowId, socket);
    const client = spawn(tmux!, ['-C', ...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    clients.push(client);
    return client;
  };
  const eventually = async <T>(read: () => Promise<T>, expected: T): Promise<void> => {
    let value = await read();
    for (let i = 0; i < 100 && JSON.stringify(value) !== JSON.stringify(expected); i++) {
      await new Promise((r) => setTimeout(r, 50));
      value = await read();
    }
    expect(value).toEqual(expected);
  };
  const lines = (out: string): string[] => out.trim().split('\n').filter(Boolean);
  const views = (run: TmuxRunner) => async (): Promise<string[]> => lines(await run(['list-sessions', '-F', '#{session_name} #{window_name}'])).sort();

  it('starts no server with no trap session, and makes no empty session beside another', async () => {
    const run = tmuxRunner(socket);
    await expect(openTmuxView(config(REPOS), undefined, { run, socket, platform: 'darwin', env: {}, openWindow: async () => undefined })).rejects.toThrow(/no trap session/);
    attach('view-a', '@0');
    await new Promise((r) => setTimeout(r, 300));
    await expect(run(['list-sessions'])).rejects.toThrow();
    await run(['new-session', '-d', '-s', 'other', 'sleep 30']);
    socketPath = (await run(['display-message', '-p', '#{socket_path}'])).trim();
    attach('view-b', '@0');
    await new Promise((r) => setTimeout(r, 300));
    expect(lines(await run(['list-sessions', '-F', '#{session_name}']))).toEqual(['other']);
  }, 30_000);

  it('keeps each view on its own window, shows every window in each, and closing a view stops no trap', async () => {
    const cfg = config(REPOS);
    const run = tmuxRunner(socket);
    const place = (repo: string) => openTmuxPane(cfg, { cwd: home, command: 'sleep 60', trap: repo, repo }, run, '/bin/sh');
    const panes = [await place('web'), await place('api')];
    socketPath = (await run(['display-message', '-p', '#{socket_path}'])).trim();
    const ids = Object.fromEntries(lines(await run(['list-windows', '-t', '=lobstah', '-F', '#{window_name} #{window_id}'])).map((l) => l.split(' ')));

    const one = attach('view-one', ids.web);
    const two = attach('view-two', ids.api);
    const listed = views(run);
    await eventually(listed, ['lobstah web', 'view-one web', 'view-two api']);
    await run(['select-window', '-t', `=view-one:${ids.api}`]);
    await eventually(listed, ['lobstah web', 'view-one api', 'view-two api']);
    await run(['select-window', '-t', `=view-two:${ids.web}`]);
    await eventually(listed, ['lobstah web', 'view-one api', 'view-two web']);

    await place('ops');
    expect(lines(await run(['list-windows', '-t', '=view-one:', '-F', '#{window_name}']))).toEqual(['web', 'api', 'ops']);
    expect(lines(await run(['list-windows', '-t', '=view-two:', '-F', '#{window_name}']))).toEqual(['web', 'api', 'ops']);
    expect((await run(['show-options', '-t', '=lobstah:', 'destroy-unattached'])).trim()).toBe('');

    one.stdin!.end();
    await eventually(listed, ['lobstah web', 'view-two web']);
    two.stdin!.end();
    await eventually(listed, ['lobstah web']);
    const alive = lines(await run(['list-panes', '-s', '-t', '=lobstah', '-F', '#{pane_id} #{pane_dead}']));
    expect(alive).toHaveLength(3);
    for (const pane of panes) expect(alive).toContain(`${pane.tmuxPane} 0`);
  }, 30_000);
});
