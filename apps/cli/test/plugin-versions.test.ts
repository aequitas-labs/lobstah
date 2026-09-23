import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — a plain .mjs script, exercised as the release path runs it
import { checkVersions, cliVersion, syncVersions, TARGETS } from '../../../scripts/sync-versions.mjs';
import { pluginRows } from '../src/doctor.js';
import { installedClaudePlugin, installedCodexPlugin, pluginBehindLine, pluginDrift } from '../src/plugin-version.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pluginver-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A copy of the repo's version-bearing files, to break and fix without touching the tree. */
function fixtureRepo(): string {
  const root = path.join(tmp, 'repo');
  for (const rel of ['apps/cli/package.json', ...(TARGETS as string[])]) {
    const src = path.join(repo, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(root, rel));
  }
  return root;
}

describe('plugin versions track the CLI', () => {
  it('every manifest in this repo carries the CLI version (the CI agreement check)', () => {
    expect(checkVersions(repo)).toEqual([]);
  });

  it('the agreement check fails on a deliberately mismatched manifest', () => {
    const root = fixtureRepo();
    const f = path.join(root, 'plugins/codex/.codex-plugin/plugin.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"version": "[^"]*"/, '"version": "0.1.0"'));
    expect(checkVersions(root)).toEqual([
      { file: 'plugins/codex/.codex-plugin/plugin.json', field: 'version', found: '0.1.0', want: cliVersion(root) },
    ]);
  });

  it('sync-versions bumps the CLI and rewrites every manifest, keeping hand formatting', () => {
    const root = fixtureRepo();
    const claude = path.join(root, 'plugins/claude-code/.claude-plugin/plugin.json');
    const before = fs.readFileSync(claude, 'utf8');
    const changed = syncVersions(root, '9.1.0') as string[];
    expect(changed).toEqual(
      expect.arrayContaining(['apps/cli/package.json', 'plugins/claude-code/.claude-plugin/plugin.json', 'plugins/codex/.codex-plugin/plugin.json', 'apps/node/package.json']),
    );
    expect(cliVersion(root)).toBe('9.1.0');
    expect(checkVersions(root)).toEqual([]);
    expect(fs.readFileSync(claude, 'utf8')).toBe(before.replace(/"version": "[^"]*"/, '"version": "9.1.0"'));
    expect(syncVersions(root)).toEqual([]); // idempotent
  });

  it('a marketplace entry that grows a version is kept in step too', () => {
    const root = fixtureRepo();
    const m = path.join(root, '.claude-plugin/marketplace.json');
    const json = JSON.parse(fs.readFileSync(m, 'utf8'));
    json.plugins[0].version = '0.0.1';
    fs.writeFileSync(m, JSON.stringify(json, null, 2) + '\n');
    expect(checkVersions(root).map((b: { field: string }) => b.field)).toEqual(['plugins[0].version']);
    syncVersions(root);
    expect(checkVersions(root)).toEqual([]);
  });
});

/** A fake ~/.claude with lobstah@lobstah installed at `version` (the cache layout Claude Code uses). */
function claudeHome(version: string): string {
  const home = path.join(tmp, `home-${version}`);
  const install = path.join(home, '.claude/plugins/cache/lobstah/lobstah', version);
  fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'lobstah', version }));
  fs.writeFileSync(
    path.join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'lobstah@lobstah': [{ scope: 'user', installPath: install, version }] } }),
  );
  return home;
}
const noHarnessEnv = { PATH: process.env.PATH };

describe('doctor: plugin rows', () => {
  it('match → ok', () => {
    const [claude] = pluginRows('0.5.0', { home: claudeHome('0.5.2'), env: noHarnessEnv });
    expect(claude).toMatchObject({ check: 'plugin claude', status: 'ok' });
    expect(claude!.detail).toContain('v0.5.2 matches CLI v0.5.0');
  });

  it('drift → warn, naming both versions and the update command', () => {
    const [claude] = pluginRows('0.5.0', { home: claudeHome('0.1.0'), env: noHarnessEnv });
    expect(claude).toMatchObject({ check: 'plugin claude', status: 'warn' });
    expect(claude!.detail).toContain('plugin v0.1.0 is behind CLI v0.5.0 — /plugin update lobstah@lobstah');
  });

  it('absent → skip, for both harnesses', () => {
    expect(pluginRows('0.5.0', { home: path.join(tmp, 'empty'), env: noHarnessEnv })).toEqual([
      { check: 'plugin claude', status: 'skip', detail: 'not installed' },
      { check: 'plugin codex', status: 'skip', detail: 'not installed' },
    ]);
  });

  it('$CLAUDE_PLUGIN_ROOT (inside the plugin’s own hook) names the loaded copy and wins', () => {
    const home = claudeHome('0.1.0');
    const root = path.join(tmp, 'live');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'lobstah', version: '0.5.0' }));
    expect(installedClaudePlugin({ home, env: { CLAUDE_PLUGIN_ROOT: root } })?.version).toBe('0.5.0');
  });

  it('codex: enabled in config.toml, newest cached version wins; disabled is absent', () => {
    const home = path.join(tmp, 'codex-home');
    for (const v of ['0.2.0', '0.10.0']) {
      const dir = path.join(home, '.codex/plugins/cache/lobstah/lobstah', v, '.codex-plugin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'lobstah', version: v }));
    }
    fs.writeFileSync(path.join(home, '.codex/config.toml'), '[plugins."lobstah@lobstah"]\nenabled = true\n');
    expect(installedCodexPlugin({ home, env: {} })?.version).toBe('0.10.0');
    fs.writeFileSync(path.join(home, '.codex/config.toml'), '[plugins."lobstah@lobstah"]\nenabled = false\n');
    expect(installedCodexPlugin({ home, env: {} })).toBeUndefined();
  });

  it('a dev build of the CLI (0.0.0-dev) compares nothing', () => {
    expect(pluginRows('0.0.0-dev', { home: claudeHome('0.1.0'), env: noHarnessEnv })[0]).toMatchObject({ status: 'skip' });
    expect(pluginBehindLine('0.0.0-dev', { home: claudeHome('0.1.0'), env: noHarnessEnv })).toBeUndefined();
  });

  it('compares major.minor only', () => {
    expect(pluginDrift('0.5.9', '0.5.0')).toBe('match');
    expect(pluginDrift('0.4.9', '0.5.0')).toBe('behind');
    expect(pluginDrift('0.10.0', '0.9.3')).toBe('ahead');
  });
});

describe('man brief: the one-line drift warning', () => {
  it('drift → one line; match and absent → nothing', () => {
    expect(pluginBehindLine('0.5.0', { home: claudeHome('0.1.0'), env: noHarnessEnv })).toBe(
      'lobstah: plugin 0.1.0 is behind CLI 0.5.0 — /plugin update lobstah@lobstah',
    );
    expect(pluginBehindLine('0.5.0', { home: claudeHome('0.5.0'), env: noHarnessEnv })).toBeUndefined();
    expect(pluginBehindLine('0.5.0', { home: path.join(tmp, 'none'), env: noHarnessEnv })).toBeUndefined();
  });

  it('end to end through the SessionStart hook: appended to the brief for drift, absent for a match', () => {
    const run = (home: string) => {
      const lobstahHome = path.join(tmp, 'lobstah');
      fs.mkdirSync(lobstahHome, { recursive: true });
      const res = spawnSync(process.execPath, [cli, 'man', 'brief'], {
        input: JSON.stringify({ session_id: 'x' }),
        encoding: 'utf8',
        // The version a release stamps (as build-binaries does); a workspace build is 0.0.0-dev by design.
        env: { PATH: process.env.PATH, HOME: home, LOBSTAH_HOME: lobstahHome, LOBSTAH_BUILD_VERSION: cliVersion(repo) },
        timeout: 10_000,
      });
      expect(res.status).toBe(0);
      return (JSON.parse(res.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    };
    const cliV = cliVersion(repo);
    const drift = run(claudeHome('0.1.0'));
    expect(drift.trimEnd().split('\n').at(-1)).toBe(`lobstah: plugin 0.1.0 is behind CLI ${cliV} — /plugin update lobstah@lobstah`);
    expect(run(claudeHome(cliV))).not.toContain('is behind CLI');
  });
});
