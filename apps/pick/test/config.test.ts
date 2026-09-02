import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { githubRepoFromOrigin, loadPickupConfig, resolveTokenSource } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-token-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LOBSTAH_TEST_TOKEN;
});

describe('token sources', () => {
  it('tokenCommand execs and caches', () => {
    const counter = path.join(dir, 'count');
    const script = path.join(dir, 'mint.cjs');
    // a script file sidesteps sh-vs-cmd quoting entirely
    fs.writeFileSync(
      script,
      `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\nconsole.log('minted-token');\n`,
    );
    const src = resolveTokenSource({ tokenCommand: `node "${script}"` }, 'test');
    expect(src()).toBe('minted-token');
    expect(src()).toBe('minted-token'); // cached — command ran once
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');
  });

  it('tokenFile reads fresh each call, supporting rotation', () => {
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, 'first\n');
    const src = resolveTokenSource({ tokenFile: file }, 'test');
    expect(src()).toBe('first');
    fs.writeFileSync(file, 'second\n');
    expect(src()).toBe('second');
  });

  it('tokenEnv reads at call time', () => {
    const src = resolveTokenSource({ tokenEnv: 'LOBSTAH_TEST_TOKEN' }, 'test');
    process.env.LOBSTAH_TEST_TOKEN = 'live';
    expect(src()).toBe('live');
  });

  it('tokenCommand wins over tokenFile and tokenEnv', () => {
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, 'from-file');
    const src = resolveTokenSource(
      { tokenCommand: 'echo from-command', tokenFile: file, tokenEnv: 'LOBSTAH_TEST_TOKEN' },
      'test',
    );
    expect(src()).toBe('from-command');
  });

  it('empty output is an error, not an empty token', () => {
    const src = resolveTokenSource({ tokenCommand: 'true' }, 'test');
    expect(() => src()).toThrow(/produced no output/);
  });

  it('no source configured is a config error', () => {
    expect(() => resolveTokenSource({}, 'test')).toThrow(/tokenCommand, tokenFile, tokenEnv/);
  });
});

describe('loadPickupConfig — linear assignment modes', () => {
  const writeConfig = (linearKeys: string) => {
    process.env.LOBSTAH_HOME = dir;
    process.env.LOBSTAH_TEST_TOKEN = 'tok';
    fs.writeFileSync(
      path.join(dir, 'config.toml'),
      `[pickup.linear]\ntokenEnv = "LOBSTAH_TEST_TOKEN"\n${linearKeys}\nroute = { ENG = "myapp" }\n`,
    );
  };
  afterEach(() => {
    delete process.env.LOBSTAH_HOME;
  });

  it('defaults to assignee with name-based start state', () => {
    writeConfig('');
    const cfg = loadPickupConfig();
    expect(cfg.linear?.assignField).toBe('assignee');
    expect(cfg.linear?.startState).toBe('Todo');
    expect(cfg.linear?.startStateTypes).toBeUndefined();
  });

  it('parses delegate mode with state-type polling', () => {
    writeConfig('assignField = "delegate"\nstartStateTypes = ["backlog", "unstarted"]');
    const cfg = loadPickupConfig();
    expect(cfg.linear?.assignField).toBe('delegate');
    expect(cfg.linear?.startStateTypes).toEqual(['backlog', 'unstarted']);
  });

  it('rejects an unknown assignField at startup', () => {
    writeConfig('assignField = "owner"');
    expect(() => loadPickupConfig()).toThrow(/assignee.*delegate/);
  });
});

describe('githubRepoFromOrigin', () => {
  it('parses the usual origin shapes', () => {
    expect(githubRepoFromOrigin('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(githubRepoFromOrigin('git@github.com:acme/widgets')).toBe('acme/widgets');
    expect(githubRepoFromOrigin('https://github.com/acme/widgets.git')).toBe('acme/widgets');
    expect(githubRepoFromOrigin('https://github.com/acme/widgets')).toBe('acme/widgets');
    expect(githubRepoFromOrigin('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets');
  });

  it('rejects non-GitHub and malformed origins', () => {
    expect(githubRepoFromOrigin('git@gitlab.com:acme/widgets.git')).toBeUndefined();
    expect(githubRepoFromOrigin('https://github.com/acme')).toBeUndefined();
  });
});

describe('loadPickupConfig — github multi-repo mode', () => {
  const write = (toml: string) => {
    process.env.LOBSTAH_HOME = dir;
    process.env.LOBSTAH_TEST_TOKEN = 'tok';
    fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  };
  afterEach(() => {
    delete process.env.LOBSTAH_HOME;
  });

  it('derives one source per repo with pickup = true and a GitHub origin', () => {
    write(`[repos.widgets]
path = "~/src/widgets"
trunk = "main"
origin = "git@github.com:acme/widgets.git"
pickup = true

[repos.gadgets]
path = "~/src/gadgets"
trunk = "main"
origin = "https://github.com/acme/gadgets"
pickup = true

[repos.private-notes]
path = "~/src/notes"
trunk = "main"

[pickup.github]
tokenEnv = "LOBSTAH_TEST_TOKEN"
identity = "acme-bot"
`);
    const cfg = loadPickupConfig();
    expect(cfg.github.map((g) => `${g.repo}→${g.key}`).sort()).toEqual(['acme/gadgets→gadgets', 'acme/widgets→widgets']);
    expect(cfg.github.every((g) => g.identity === 'acme-bot')).toBe(true);
  });

  it('applies per-repo overrides on top of the shared merge policy', () => {
    write(`[repos.widgets]
path = "~/src/widgets"
trunk = "main"
origin = "git@github.com:acme/widgets.git"
pickup = true

[repos.gadgets]
path = "~/src/gadgets"
trunk = "main"
origin = "git@github.com:acme/gadgets.git"
pickup = true

[pickup.github]
tokenEnv = "LOBSTAH_TEST_TOKEN"
identity = "acme-bot"

[pickup.github.merge]
enabled = true
approvers = ["alice"]

[pickup.github.overrides.gadgets]
startLabel = "bot-work"

[pickup.github.overrides.gadgets.merge]
enabled = false
`);
    const cfg = loadPickupConfig();
    const widgets = cfg.github.find((g) => g.key === 'widgets')!;
    const gadgets = cfg.github.find((g) => g.key === 'gadgets')!;
    expect(widgets.merge.enabled).toBe(true);
    expect(widgets.startLabel).toBe('lobstah');
    expect(gadgets.merge.enabled).toBe(false);
    expect(gadgets.merge.approvers).toEqual(['alice']);
    expect(gadgets.startLabel).toBe('bot-work');
  });

  it('explicit repo/key stays single-repo mode and ignores repo opt-ins', () => {
    write(`[repos.widgets]
path = "~/src/widgets"
trunk = "main"
origin = "git@github.com:acme/widgets.git"
pickup = true

[pickup.github]
tokenEnv = "LOBSTAH_TEST_TOKEN"
identity = "acme-bot"
repo = "acme/monolith"
key = "monolith"
`);
    const cfg = loadPickupConfig();
    expect(cfg.github).toHaveLength(1);
    expect(cfg.github[0]!.repo).toBe('acme/monolith');
  });

  it('multi-repo mode with no opted-in repos is a startup error', () => {
    write(`[repos.widgets]
path = "~/src/widgets"
trunk = "main"
origin = "git@github.com:acme/widgets.git"

[pickup.github]
tokenEnv = "LOBSTAH_TEST_TOKEN"
identity = "acme-bot"
`);
    expect(() => loadPickupConfig()).toThrow(/pickup = true/);
  });

  it('pickup = true without a usable GitHub origin is a startup error', () => {
    write(`[repos.widgets]
path = "~/src/widgets"
trunk = "main"
origin = "git@gitlab.com:acme/widgets.git"
pickup = true

[pickup.github]
tokenEnv = "LOBSTAH_TEST_TOKEN"
identity = "acme-bot"
`);
    expect(() => loadPickupConfig()).toThrow(/not a GitHub URL/);
  });
});
