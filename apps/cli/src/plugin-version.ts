import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';

/**
 * Plugin versions track the CLI's: one version, stamped into every plugin
 * manifest by scripts/sync-versions.mjs. This module finds the version of
 * the plugin a harness actually loads, so doctor and the SessionStart brief
 * can warn when it drifts from the CLI.
 *
 * Where the harnesses load from (verified on this machine, 2026-09-23):
 * - Claude Code: `~/.claude/plugins/installed_plugins.json` →
 *   plugins["lobstah@lobstah"][0].installPath, a versioned copy under
 *   `~/.claude/plugins/cache/lobstah/lobstah/<version>/`. That copy is what
 *   runs; `~/.claude/plugins/marketplaces/lobstah/` is only the marketplace
 *   checkout it installs from. Inside the plugin's own hooks,
 *   $CLAUDE_PLUGIN_ROOT names the loaded copy directly, and wins.
 * - Codex: `~/.codex/config.toml` enables `[plugins."lobstah@lobstah"]`, and
 *   the loaded copy is `~/.codex/plugins/cache/lobstah/lobstah/<version>/`.
 */

export type PluginHarness = 'claude' | 'codex';

export interface InstalledPlugin {
  harness: PluginHarness;
  version: string;
  /** The directory the harness loads the plugin from. */
  root: string;
}

export const UPDATE_COMMAND: Record<PluginHarness, string> = {
  claude: '/plugin update lobstah@lobstah',
  codex: 'codex plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah',
};

interface Env {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const manifestVersion = (file: string): string | undefined => {
  const m = readJson<{ name?: string; version?: string }>(file);
  return m?.name === 'lobstah' && typeof m.version === 'string' ? m.version : undefined;
};

/** The Claude Code plugin the harness loads, or undefined when none is installed. */
export function installedClaudePlugin(opts: Env = {}): InstalledPlugin | undefined {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const version = manifestVersion(path.join(root, '.claude-plugin', 'plugin.json'));
    if (version) return { harness: 'claude', version, root };
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  const installed = readJson<{ plugins?: Record<string, Array<{ installPath?: string; version?: string }>> }>(
    path.join(claudeDir, 'plugins', 'installed_plugins.json'),
  );
  const entry = installed?.plugins?.['lobstah@lobstah']?.[0];
  if (!entry?.installPath) return undefined;
  const version = manifestVersion(path.join(entry.installPath, '.claude-plugin', 'plugin.json')) ?? entry.version;
  return version ? { harness: 'claude', version, root: entry.installPath } : undefined;
}

/** The Codex plugin the harness loads, or undefined when it isn't installed and enabled. */
export function installedCodexPlugin(opts: Env = {}): InstalledPlugin | undefined {
  const env = opts.env ?? process.env;
  const codexDir = env.CODEX_HOME ?? path.join(opts.home ?? os.homedir(), '.codex');
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const entry = ((cfg.plugins ?? {}) as Record<string, { enabled?: boolean }>)['lobstah@lobstah'];
  if (!entry || entry.enabled === false) return undefined;
  const cache = path.join(codexDir, 'plugins', 'cache', 'lobstah', 'lobstah');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(cache);
  } catch {
    return undefined;
  }
  // Several cached versions can sit side by side; the newest is the live one.
  for (const d of dirs.sort(compareVersions).reverse()) {
    const root = path.join(cache, d);
    const version = manifestVersion(path.join(root, '.codex-plugin', 'plugin.json'));
    if (version) return { harness: 'codex', version, root };
  }
  return undefined;
}

interface Semver {
  core: [number, number, number];
  pre: string[];
}

const parseSemver = (v: string): Semver => {
  const [main = '', ...rest] = v.trim().replace(/^v/, '').split('+')[0]!.split('-');
  const n = main.split('.').map((x) => Number(x) || 0);
  const pre = rest.join('-');
  return { core: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre: pre ? pre.split('.') : [] };
};

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  // A prerelease sorts before its release.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (np && nq) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export type Drift = 'match' | 'behind' | 'ahead';
/** How far apart two unequal versions are: the highest part that differs. */
export type Gap = 'major' | 'minor' | 'patch';

/**
 * Compares the full version. Every release can change what a skill
 * describes (0.5.9 changed the man skill), so a patch gap is drift too.
 */
export function pluginDrift(pluginVersion: string, cliVersion: string): Drift {
  const c = compareVersions(pluginVersion, cliVersion);
  return c === 0 ? 'match' : c < 0 ? 'behind' : 'ahead';
}

/** The highest version part that differs; undefined for equal versions. */
export function versionGap(a: string, b: string): Gap | undefined {
  const [x, y] = [parseSemver(a).core, parseSemver(b).core];
  if (x[0] !== y[0]) return 'major';
  if (x[1] !== y[1]) return 'minor';
  return compareVersions(a, b) === 0 ? undefined : 'patch';
}

/**
 * The SessionStart brief's one line, only when the plugin the running
 * harness loaded is behind the CLI; undefined otherwise (nothing installed,
 * equal, or ahead). A patch gap counts. The hook's own environment says
 * which harness runs it: CLAUDE* → Claude Code's plugin, only CODEX* →
 * Codex's. Never throws — a
 * hook must never fail a session start.
 */
export function pluginBehindLine(cliVersion: string, opts: Env = {}): string | undefined {
  try {
    if (cliVersion.startsWith('0.0.0')) return undefined; // a dev build: nothing to compare
    const keys = Object.keys(opts.env ?? process.env);
    const codexOnly = keys.some((k) => k.startsWith('CODEX')) && !keys.some((k) => k.startsWith('CLAUDE'));
    const p = codexOnly ? installedCodexPlugin(opts) : installedClaudePlugin(opts);
    if (!p || pluginDrift(p.version, cliVersion) !== 'behind') return undefined;
    return `lobstah: plugin ${p.version} is behind CLI ${cliVersion} — ${UPDATE_COMMAND[p.harness]}`;
  } catch {
    return undefined;
  }
}
