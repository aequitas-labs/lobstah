import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '@lobstah/core';
import type { Config } from '@lobstah/core';
import { openTmuxPane, tmuxConfigFile, tmuxPaneTail, tmuxPlacementLockFile, tmuxRunner, tmuxServerEnv, tmuxWindowFor, TMUX_CONFIG } from '../src/tmux-terminal.js';
import type { TmuxRunner, TmuxWindow } from '../src/tmux-terminal.js';
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
    expect(tmuxWindowFor(fixed, 'web', [{ id: '@0', name: 'page-1', panes: 1 }])).toBe('page-1');
    expect(tmuxWindowFor(fixed, 'web', [{ id: '@0', name: 'page-1', panes: 2 }, { id: '@1', name: 'page-2', panes: 2 }])).toBe('page-3');
  });
});

/**
 * What tmux prints for a `-F` format to a client without a UTF-8 locale:
 * every control character, a tab among them, becomes `_`.
 */
const printed = (format: string, fields: Record<string, string | number>): string =>
  [...format.replace(/#\{(\w+)\}/g, (_, key: string) => String(fields[key] ?? ''))].map((c) => (c.charCodeAt(0) < 32 ? '_' : c)).join('');

/** `list-windows` output for these windows, in the format the caller asked for. */
const listed = (args: string[], windows: readonly { id: string; name: string; panes: number }[]): string =>
  windows.map((w) => `${printed(args[args.indexOf('-F') + 1]!, { window_id: w.id, window_name: w.name, window_panes: w.panes })}\n`).join('');

describe('opening a trap pane', () => {
  const fake = (windows?: TmuxWindow[]) => {
    const seen: string[][] = [];
    const run: TmuxRunner = async (args) => {
      seen.push(args);
      if (args[0] === 'list-windows') {
        if (windows === undefined) throw new Error('no server running');
        return listed(args, windows);
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
    expect(first.seen.slice(2)).toEqual([['select-layout', '-t', '%7', 'tiled'], ['select-pane', '-t', '%7', '-T', launch.trap]]);
    const joined = fake([{ id: '@3', name: 'web', panes: 2 }]);
    await openTmuxPane(cfg, launch, joined.run, '/bin/zsh');
    expect(joined.seen[1]!.slice(0, 4)).toEqual(['split-window', '-d', '-t', '@3']);
    const added = fake([{ id: '@1', name: 'api', panes: 1 }]);
    await openTmuxPane(cfg, launch, added.run, '/bin/zsh');
    expect(added.seen[1]!.slice(0, 5)).toEqual(['new-window', '-d', '-t', '=lobstah:', '-n']);
    expect([first, joined, added].flatMap((f) => f.seen).some((a) => a.includes('select-window') || a.includes('attach'))).toBe(false);
    expect(fs.readFileSync(tmuxConfigFile(), 'utf8')).toBe(TMUX_CONFIG);
  });

  it('reports a running pane as launched when tiling or titling it fails', async () => {
    const run: TmuxRunner = async (args) => {
      if (args[0] === 'list-windows') throw new Error('no server running');
      if (args[0] === 'select-layout' || args[0] === 'select-pane') throw new Error("tmux select-layout failed: can't find window: web");
      return '%7\n';
    };
    expect(await openTmuxPane(config(REPOS), launch, run, '/bin/zsh')).toEqual({ tmuxPane: '%7' });
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

/** A tmux server in memory, slow enough per call that unserialised placements would interleave. */
const fakeServer = () => {
  const windows: { id: string; name: string; panes: string[] }[] = [];
  let next = 0;
  const open = (name: string) => {
    const w = { id: `@${windows.length}`, name, panes: [`%${next++}`] };
    windows.push(w);
    return `${w.panes[0]}\n`;
  };
  const arg = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]!;
  const run: TmuxRunner = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    switch (args[0]) {
      case 'list-windows':
        if (!windows.length) throw new Error('no server running');
        return listed(args, windows.map((w) => ({ ...w, panes: w.panes.length })));
      case 'new-session':
        if (windows.length) throw new Error('duplicate session: lobstah');
        return open(arg(args, '-n'));
      case 'new-window':
        return open(arg(args, '-n'));
      case 'split-window': {
        const w = windows.find((x) => x.id === arg(args, '-t'));
        if (!w) throw new Error(`can't find window: ${arg(args, '-t')}`);
        w.panes.push(`%${next++}`);
        return `${w.panes.at(-1)}\n`;
      }
      default:
        return '';
    }
  };
  return { windows, run };
};

describe('traps thrown at the same moment', () => {
  const launch = (trap: string) => ({ cwd: '/w', command: 'true', trap, repo: 'web' });

  it('share one session and one repo window, from a cold start', async () => {
    const server = fakeServer();
    const cfg = config(REPOS);
    const panes = await Promise.all(['a', 'b', 'c', 'd'].map((t) => openTmuxPane(cfg, launch(t), server.run, '/bin/sh')));
    expect(server.windows.map((w) => [w.name, w.panes.length])).toEqual([['web', 4]]);
    expect(new Set(panes.map((p) => p.tmuxPane)).size).toBe(4);
    expect(fs.existsSync(tmuxPlacementLockFile())).toBe(false);
  });

  it('fill each fixed page to its size before opening the next', async () => {
    const server = fakeServer();
    const cfg = config(`${REPOS}[soak]\ntmuxPages = "fixed"\ntmuxPageSize = 2\n`);
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((t) => openTmuxPane(cfg, launch(t), server.run, '/bin/sh')));
    expect(server.windows.map((w) => [w.name, w.panes.length])).toEqual([['page-1', 2], ['page-2', 2], ['page-3', 1]]);
  });

  it('split the first of two windows that share a name, by its id', async () => {
    const server = fakeServer();
    server.windows.push({ id: '@0', name: 'web', panes: ['%90'] }, { id: '@1', name: 'web', panes: ['%91'] });
    await openTmuxPane(config(REPOS), launch('a'), server.run, '/bin/sh');
    expect(server.windows.map((w) => w.panes.length)).toEqual([2, 1]);
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

  /** The locales a throw meets: a person's shell, `LANG=C`, and a daemon with none set. */
  const LOCALES: [string, NodeJS.ProcessEnv][] = [
    ['UTF-8', { LANG: 'en_US.UTF-8' }],
    ['C', { LANG: 'C', LC_ALL: 'C' }],
    ['unset', {}],
  ];
  const localeEnv = (locale: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'LANG' && !k.startsWith('LC_'))),
    ...locale,
    LOBSTAH_HOME: home,
  });
  /** One throw's placement in its own process, through the built openTmuxPane and tmuxRunner. */
  const throwFromProcess = (trap: string, locale: NodeJS.ProcessEnv) => {
    const module = fileURLToPath(new URL('../dist/tmux-terminal.js', import.meta.url));
    const script = [
      `import { loadConfig } from '@lobstah/core';`,
      `import { openTmuxPane, tmuxRunner } from ${JSON.stringify(module)};`,
      `const pane = await openTmuxPane(loadConfig(), { cwd: ${JSON.stringify(home)}, command: 'sleep 30', trap: '${trap}', repo: 'web' }, tmuxRunner(${JSON.stringify(socket)}), '/bin/sh');`,
      `console.log(pane.tmuxPane);`,
    ].join('\n');
    return promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: localeEnv(locale) });
  };
  const traps = ['amber-gull', 'misty-dune', 'quiet-wave', 'rapid-buoy'];

  describe.each(LOCALES)('with the %s locale', (_, locale) => {
    const placed = async (outs: { stdout: string; stderr: string }[], layout: string[]) => {
      const run = tmuxRunner(socket);
      socketPath = (await run(['display-message', '-p', '#{socket_path}'])).trim();
      expect(outs.map((o) => o.stderr)).toEqual(outs.map(() => ''));
      expect((await run(['list-windows', '-t', '=lobstah', '-F', '#{window_name} #{window_panes}'])).trim().split('\n')).toEqual(layout);
      const panes = (await run(['list-panes', '-s', '-t', '=lobstah', '-F', '#{pane_id} #{pane_dead} #{pane_title}'])).trim().split('\n');
      expect(panes.map((p) => p.split(' ').slice(1).join(' ')).sort()).toEqual(traps.map((t) => `0 ${t}`));
      expect(panes.map((p) => p.split(' ')[0]).sort()).toEqual(outs.map((o) => o.stdout.trim()).sort());
    };

    it('places throws one after another in one repo window', async () => {
      config(REPOS);
      const outs = [];
      for (const t of traps) outs.push(await throwFromProcess(t, locale));
      await placed(outs, ['web 4']);
    }, 30_000);

    it('places throws from 4 processes at once in one repo window', async () => {
      config(REPOS);
      await placed(await Promise.all(traps.map((t) => throwFromProcess(t, locale))), ['web 4']);
    }, 30_000);

    it('fills fixed pages in order under throws from 4 processes at once', async () => {
      config(`${REPOS}[soak]\ntmuxPages = "fixed"\ntmuxPageSize = 2\n`);
      await placed(await Promise.all(traps.map((t) => throwFromProcess(t, locale))), ['page-1 2', 'page-2 2']);
    }, 30_000);
  });
});
