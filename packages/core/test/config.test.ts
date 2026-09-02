import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, loadConfig, resolveDispatch } from '../src/index.js';

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
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('config precedence: descriptor > repo > global > default', () => {
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
