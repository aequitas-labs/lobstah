import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, loadConfig, resolveDispatch } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.myapp]
path = "/tmp/myapp"
trunk = "main"
env = { A = "repo" }

[repos.myapp.harness]
model = "opus"

[harness]
default = "claude"
model = "sonnet"

[limits]
wallClockSecs = 100
`,
  );
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('config precedence: descriptor > repo > global > default', () => {
  it('defaults ready settling to 600 seconds, accepts 0, and rejects invalid periods', () => {
    expect(loadConfig().readySettleSecs).toBe(600);
    for (const secs of [0, 30]) {
      fs.writeFileSync(path.join(home, 'config.toml'), `readySettleSecs = ${secs}\n`);
      expect(loadConfig().readySettleSecs).toBe(secs);
    }
    for (const value of ['-1', '"soon"', 'true', 'inf', 'nan']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `readySettleSecs = ${value}\n`);
      expect(() => loadConfig()).toThrow(/readySettleSecs must be a non-negative number/);
    }
  });
  it('defaults the idle-claim notice grace to 180 seconds and honors the soak override', () => {
    expect(loadConfig().soak.claimIdleNoticeSecs).toBe(180);
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[soak]\nclaimIdleNoticeSecs = 240\n');
    expect(loadConfig().soak.claimIdleNoticeSecs).toBe(240);
  });
  it('repo overrides global', () => {
    const r = resolveDispatch({ id: 'x', repo: 'myapp', brief: 'b' }, loadConfig());
    expect(r.harness).toBe('claude');
    expect(r.model).toBe('opus');
    expect(r.limits.wallClockSecs).toBe(100);
  });

  it('descriptor overrides repo', () => {
    const r = resolveDispatch(
      { id: 'x', repo: 'myapp', brief: 'b', model: 'haiku', env: { A: 'dispatch' }, limits: { wallClockSecs: 5 } },
      loadConfig(),
    );
    expect(r.model).toBe('haiku');
    expect(r.env.A).toBe('dispatch');
    expect(r.limits.wallClockSecs).toBe(5);
  });

  it('an unresolvable repo key fails the dispatch immediately', () => {
    expect(() => resolveDispatch({ id: 'x', repo: 'nope', brief: 'b' }, loadConfig())).toThrow(/unknown repo key/);
  });
});
