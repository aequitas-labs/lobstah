import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '@lobstah/core';
import type { Config } from '@lobstah/core';
import { openTmuxPane, tmuxConfigFile, tmuxPaneTail, tmuxRunner, tmuxServerEnv, tmuxWindowFor, TMUX_CONFIG } from '../src/tmux-terminal.js';
import type { TmuxRunner } from '../src/tmux-terminal.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tmux-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const config = (toml: string): Config => {
  fs.writeFileSync(path.join(home, 'config.toml'), toml);
  return loadConfig();
};
const REPOS = '[repos.web]\npath = "/w"\n[repos.api]\npath = "/a"\n[repos.ops]\npath = "/o"\n';

describe('tmux settings', () => {
  it('is opt-in: no setting keeps Terminal.app, and tmux pages by repo, 6 a window, by default', () => {
    expect(config('').soak).toMatchObject({ tmuxPages: 'repo', tmuxPageSize: 6 });
    expect(config('').soak.terminal).toBeUndefined();
    expect(config('[soak]\nterminal = "tmux"\ntmuxPages = "fixed"\ntmuxPageSize = 9\n').soak).toMatchObject({ terminal: 'tmux', tmuxPages: 'fixed', tmuxPageSize: 9 });
    expect(() => config('[soak]\ntmuxPages = "trap"\n')).toThrow(/soak.tmuxPages: unknown paging "trap"/);
    expect(() => config('[soak]\ntmuxPageSize = 0\n')).toThrow(/tmuxPageSize must be a positive whole number/);
  });
});

describe('which window a trap joins', () => {
  it('pages by repo, by grounds (the implicit home covers every repo), or in fixed windows', () => {
    const byRepo = config(`${REPOS}[soak]\nterminal = "tmux"\n`);
    expect(tmuxWindowFor(byRepo, 'web', [])).toBe('web');
    const byGrounds = config(`${REPOS}[soak]\ntmuxPages = "grounds"\n`);
    expect(tmuxWindowFor(byGrounds, 'web', [])).toBe('home');
    const split = config(`${REPOS}[grounds.product]\nrepos = ["web", "api"]\n[grounds.infra]\nrepos = ["ops"]\n[soak]\ntmuxPages = "grounds"\n`);
    expect([tmuxWindowFor(split, 'api', []), tmuxWindowFor(split, 'ops', [])]).toEqual(['product', 'infra']);
    const fixed = config(`${REPOS}[soak]\ntmuxPages = "fixed"\ntmuxPageSize = 2\n`);
    expect(tmuxWindowFor(fixed, 'web', [])).toBe('page-1');
    expect(tmuxWindowFor(fixed, 'web', [{ name: 'page-1', panes: 1 }])).toBe('page-1');
    expect(tmuxWindowFor(fixed, 'web', [{ name: 'page-1', panes: 2 }, { name: 'page-2', panes: 2 }])).toBe('page-3');
  });
});

describe('opening a trap pane', () => {
  const fake = (windows?: string) => {
    const seen: string[][] = [];
    const run: TmuxRunner = async (args) => {
      seen.push(args);
      if (args[0] === 'list-windows') {
        if (windows === undefined) throw new Error('no server running');
        return windows;
      }
      return args.includes('-P') ? '%7\n' : '';
    };
    return { seen, run };
  };
  const launch = { cwd: '/w', command: "cd '/w' && 'claude' '/lobstah:trap soak --ticket t'", trap: 'amber-gull (wt:deadbeef)', repo: 'web' };

  it("starts lobstah's session, splits an existing window, tiles it, and titles the pane, never taking focus", async () => {
    const cfg = config(REPOS);
    const first = fake();
    expect(await openTmuxPane(cfg, launch, first.run, '/bin/zsh')).toEqual({ tmuxPane: '%7' });
    expect(first.seen[1]).toEqual(['new-session', '-d', '-s', 'lobstah', '-n', 'web', '-x', '240', '-y', '66', '-c', '/w', '-P', '-F', '#{pane_id}', '/bin/zsh', '-l', '-c', launch.command]);
    expect(first.seen.slice(2)).toEqual([['select-layout', '-t', '=lobstah:=web', 'tiled'], ['select-pane', '-t', '%7', '-T', launch.trap]]);
    const joined = fake('web\t2\n');
    await openTmuxPane(cfg, launch, joined.run, '/bin/zsh');
    expect(joined.seen[1]!.slice(0, 4)).toEqual(['split-window', '-d', '-t', '=lobstah:=web']);
    const added = fake('api\t1\n');
    await openTmuxPane(cfg, launch, added.run, '/bin/zsh');
    expect(added.seen[1]!.slice(0, 5)).toEqual(['new-window', '-d', '-t', '=lobstah:', '-n']);
    expect([first, joined, added].flatMap((f) => f.seen).some((a) => a.includes('select-window') || a.includes('attach'))).toBe(false);
    expect(fs.readFileSync(tmuxConfigFile(), 'utf8')).toBe(TMUX_CONFIG);
  });

  it("keeps a person's edits to lobstah's tmux config", async () => {
    fs.writeFileSync(tmuxConfigFile(), 'set -g mouse off\n');
    await openTmuxPane(config(REPOS), launch, fake().run, '/bin/zsh');
    expect(fs.readFileSync(tmuxConfigFile(), 'utf8')).toBe('set -g mouse off\n');
  });

  it("starts the server without the thrower's session variables", () => {
    const env = tmuxServerEnv({ HOME: '/h', PATH: '/bin', LOBSTAH_HOME: '/l', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'helm', TMUX: '/s,1,0' });
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', LOBSTAH_HOME: '/l' });
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

describe.skipIf(!hasTmux)('a real tmux server', () => {
  const socket = `lobstah-test-${process.pid}`;
  let socketPath: string | undefined;
  afterEach(() => {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    // kill-server leaves the socket file behind.
    if (socketPath) fs.rmSync(socketPath, { force: true });
  });

  it('tiles two trap panes in the repo window, titled, and reads a pane screen back', async () => {
    const cfg = config(REPOS);
    const run = tmuxRunner(socket);
    const one = await openTmuxPane(cfg, { cwd: home, command: 'echo first trap; sleep 30', trap: 'amber-gull', repo: 'web' }, run, '/bin/sh');
    const two = await openTmuxPane(cfg, { cwd: home, command: 'echo second trap; sleep 30', trap: 'misty-dune', repo: 'web' }, run, '/bin/sh');
    socketPath = (await run(['display-message', '-p', '#{socket_path}'])).trim();
    const panes = (await run(['list-panes', '-t', '=lobstah:=web', '-F', '#{pane_id} #{pane_title}'])).trim().split('\n');
    expect(panes).toEqual([`${one.tmuxPane} amber-gull`, `${two.tmuxPane} misty-dune`]);
    let screen: string | undefined;
    for (let i = 0; i < 50 && !screen?.includes('second trap'); i++) {
      screen = await tmuxPaneTail(two.tmuxPane, 6, run);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(screen).toContain('second trap');
  });
});
