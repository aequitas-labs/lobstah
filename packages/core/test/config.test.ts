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
  it('validates the optional repo trap count', () => {
    expect(loadConfig().repos.myapp?.traps).toBeUndefined();
    for (const traps of ['0', '2', '10']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[repos.myapp]\npath = '/tmp/app'\ntraps = ${traps}\n`);
      expect(loadConfig().repos.myapp?.traps).toBe(Number(traps));
    }
    for (const traps of ['-1', '2.5', '"2"', 'true']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[repos.myapp]\npath = '/tmp/app'\ntraps = ${traps}\n`);
      expect(() => loadConfig()).toThrow('[repos.myapp].traps must be a non-negative whole number');
    }
  });
  it('validates repo review presets and templates', () => {
    expect(loadConfig().repos.myapp?.reviewTool).toBeUndefined();
    for (const review of ['github', 'graphite', 'linear', 'linear-app', 'https://review.example/{owner}/{repo}/{number}']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[repos.myapp]\npath = "/tmp/app"\nreviewTool = "${review}"\n`);
      expect(loadConfig().repos.myapp?.reviewTool).toBe(review);
    }
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.myapp]\nreviewTool = "javascript:alert(1)"\n');
    expect(() => loadConfig()).toThrow('[repos.myapp].reviewTool must be');
  });
  it('defaults pet clicks to tabs and validates all explicit routes', () => {
    expect(loadConfig().pet.open).toBe('tab');
    for (const open of ['tab', 'app', 'helm']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[pet]\nopen = "${open}"\n`);
      expect(loadConfig().pet.open).toBe(open);
    }
    fs.writeFileSync(path.join(home, 'config.toml'), '[pet]\nopen = "browser"\n');
    expect(() => loadConfig()).toThrow('[pet].open must be');
  });
  it('validates the Codex sign-on window', () => {
    expect(loadConfig().soak.codexStartSecs).toBe(600);
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\ncodexStartSecs = 900\n');
    expect(loadConfig().soak.codexStartSecs).toBe(900);
    for (const value of ['0', '-1', '1.5', '"600"', 'true']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[soak]\ncodexStartSecs = ${value}\n`);
      expect(() => loadConfig()).toThrow('codexStartSecs must be a positive whole number');
    }
  });
  it('defaults hosted starts off and accepts only an explicit boolean opt-in', () => {
    expect(loadConfig().soak.acceptWharfStarts).toBe(false);
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[soak]\nacceptWharfStarts = true\n');
    expect(loadConfig().soak.acceptWharfStarts).toBe(true);
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nacceptWharfStarts = "yes"\n');
    expect(() => loadConfig()).toThrow('acceptWharfStarts must be true or false');
  });
  it('defaults repair cooldown off and validates the watch override', () => {
    expect(loadConfig().watch.repairCooldownSecs).toBe(0);
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[watch]\nrepairCooldownSecs = 3600\n');
    expect(loadConfig().watch.repairCooldownSecs).toBe(3600);
    for (const value of ['-1', '"later"', 'true', 'inf', 'nan']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[watch]\nrepairCooldownSecs = ${value}\n`);
      expect(() => loadConfig()).toThrow(/repairCooldownSecs must be a non-negative number/);
    }
  });
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
  it('[permissions] lists extend the auto-mode profile; a mistyped key or rule is refused', () => {
    expect(loadConfig().permissions).toEqual({ environment: [], allow: [], deny: [], codex: { forbidden: [], prompt: [], allow: [] } });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `[permissions]\nenvironment = ["**Trusted orgs**: acme"]\nallow = ["Bash(wrangler dev *)", "Bash(wrangler dev *)"]\ndeny = ["Bash(vercel env pull *)"]\n`,
    );
    expect(loadConfig().permissions).toEqual({
      environment: ['**Trusted orgs**: acme'],
      allow: ['Bash(wrangler dev *)'],
      deny: ['Bash(vercel env pull *)'],
      codex: { forbidden: [], prompt: [], allow: [] },
    });
    fs.writeFileSync(path.join(home, 'config.toml'), `[permissions.codex]\nforbidden = [["vercel", "env", "pull"], ["vercel", "env", "pull"]]\nallow = [["wrangler", "dev"]]\n`);
    expect(loadConfig().permissions.codex).toEqual({ forbidden: [['vercel', 'env', 'pull']], prompt: [], allow: [['wrangler', 'dev']] });
    for (const [body, error] of [
      ['allows = ["Read"]', /\[permissions\]\.allows is not a key/],
      ['allow = "Read"', /\[permissions\]\.allow must be a list of non-empty strings/],
      ['allow = ["wrangler dev"]', /"wrangler dev" is not a permission rule/],
      ['codex = { allow = ["wrangler dev"] }', /\[permissions\.codex\]\.allow must be a list of command prefixes/],
      ['codex = { allows = [] }', /\[permissions\.codex\]\.allows is not a key/],
    ] as const) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[permissions]\n${body}\n`);
      expect(() => loadConfig()).toThrow(error);
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
