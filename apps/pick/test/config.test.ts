import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPickupConfig, resolveTokenSource } from '../src/config.js';

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
