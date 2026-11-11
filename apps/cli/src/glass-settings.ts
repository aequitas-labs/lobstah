import * as fs from 'node:fs';
import { configPath, displayGrounds, executorPath, groundsList, loadConfig, lobstahVersion, repoTrapCount } from '@lobstah/core';
import type { Config, GlassSettings, SettingRow, SettingsRepo, SettingsSection, SettingsVersion } from '@lobstah/core';
import { parse } from 'smol-toml';
import { installedClaudePlugin, installedCodexPlugin, pluginDrift } from './plugin-version.js';
import { HEARTBEAT_STALE_MS } from './tend.js';

/**
 * The glass's read-only Settings tab: the effective configuration from the
 * loader the CLI uses, each value marked as set in config.toml or a default.
 * Secrets are masked here, before anything is sent, so a raw value never
 * reaches the browser. Nothing in this module writes.
 */

/** What a secret value shows as. */
export const SECRET_MASK = '•••• (set)';

export type { GlassSettings, SettingRow, SettingSource, SettingsGrounds, SettingsRepo, SettingsSection, SettingsVersion } from '@lobstah/core';

/** Words in a key's name that mark its value as a secret. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd', 'passphrase',
  'credential', 'credentials', 'apikey', 'key', 'keys', 'webhook', 'webhooks', 'bearer', 'cookie', 'cookies',
  'auth', 'authorization', 'private', 'env',
]);

/** What a secret looks like inside any string, whatever its key is called. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}/,
  /\bgithub_pat_\w+/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bxox[a-z]-[A-Za-z0-9-]+/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+\S+/i,
  // A URL carrying credentials, a webhook, or a secret in its query.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i,
  /https?:\/\/\S*(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|webhook)/i,
  /[?&](?:token|key|secret|password|api[-_]?key|sig|signature)=/i,
  // An assignment or a flag, in a command or an env-style line.
  /(?:token|secret|password|passwd|api[-_]?key)\s*[=:]\s*\S+/i,
  /--(?:token|secret|password|passwd|api-key)\s+\S+/i,
  // A long opaque string.
  /\b[0-9a-f]{32,}\b/i,
  /(?<![\w/.-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/.-])/,
];

/** Whether a key's name marks its value as a secret: `apiKey`, `github_token`, `WEBHOOK`. */
export function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map((word) => word.toLowerCase());
  return words.some((word) => SECRET_WORDS.has(word)) || SECRET_WORDS.has(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
}

/** Whether a string looks like a secret, or holds one. */
export function looksSecret(text: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(text));
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * A value with every secret in it replaced by the mask, at any depth. Inside a
 * key named like a secret, every value is masked; elsewhere a string is masked
 * by its shape. An empty value stays empty: there's nothing to hide.
 */
export function maskSecrets(value: unknown, insideSecret = false): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, insideSecret));
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item, insideSecret || isSecretKey(key))]));
  }
  if (value === null || value === undefined || value === '') return value;
  if (insideSecret) return SECRET_MASK;
  return typeof value === 'string' && looksSecret(value) ? SECRET_MASK : value;
}

/** A masked value as one line of text. */
function settingText(masked: unknown): string {
  if (masked === null || masked === undefined || masked === '') return '(empty)';
  if (typeof masked === 'string') return masked;
  if (Array.isArray(masked)) {
    if (masked.length === 0) return '(none)';
    return masked.every((item) => typeof item === 'string') ? masked.join(', ') : JSON.stringify(masked);
  }
  if (isTable(masked)) return Object.keys(masked).length === 0 ? '(none)' : JSON.stringify(masked);
  return String(masked);
}

/** Effective values, plus anything the file sets that the loader doesn't read. The effective value wins. */
function withFileOnlyValues(effective: unknown, file: unknown): unknown {
  if (!isTable(file)) return effective === undefined ? file : effective;
  if (effective !== undefined && !isTable(effective)) return effective;
  const merged: Record<string, unknown> = { ...(effective as Record<string, unknown> | undefined) };
  for (const [key, value] of Object.entries(file)) merged[key] = withFileOnlyValues(merged[key], value);
  return merged;
}

/** Whether the file sets this path. */
function fileSets(file: unknown, path: readonly string[]): boolean {
  let at: unknown = file;
  for (const part of path) {
    if (!isTable(at) || !(part in at)) return false;
    at = at[part];
  }
  return true;
}

/** Tables whose keys are names people chose, so a repo called `auth-api` doesn't hide its own settings. */
const NAMED_TABLES: ReadonlySet<string> = new Set(['repos', 'grounds', 'pools', 'wharves']);
const isNameLevel = (path: readonly string[]): boolean =>
  (path.length === 1 && NAMED_TABLES.has(path[0]!)) || (path.length === 2 && path[0] === 'heavy' && path[1] === 'repos');

/** A value's rows, flattened to dotted keys under `path`. `shownFrom` is where the key starts when it's shown. */
function settingRows(value: unknown, path: readonly string[], file: unknown, shownFrom: number, insideSecret = false): SettingRow[] {
  if (value === undefined) return [];
  if (isTable(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) =>
      settingRows(item, [...path, key], file, shownFrom, insideSecret || (!isNameLevel(path) && isSecretKey(key))));
  }
  const key = path.slice(shownFrom).join('.');
  return [{
    key: looksSecret(key) ? SECRET_MASK : key,
    value: settingText(maskSecrets(value, insideSecret)),
    source: fileSets(file, path) ? 'config' : 'default',
  }];
}

/** The sections after grounds and repos, in the order a person looks for them. */
const SECTIONS: ReadonlyArray<{ key: keyof Config | string; title: string }> = [
  { key: 'helm', title: 'Helm' },
  { key: 'soak', title: 'Soak' },
  { key: 'heavy', title: 'Heavy' },
  { key: 'hooks', title: 'Hooks' },
  { key: 'attentionKinds', title: 'Attention kinds' },
  { key: 'readySettleSecs', title: 'Attention timing' },
  { key: 'remindSecs', title: 'Attention timing' },
  { key: 'watch', title: 'Watches' },
  { key: 'wait', title: 'Waits' },
  { key: 'limits', title: 'Limits' },
  { key: 'harness', title: 'Harness' },
  { key: 'pools', title: 'Pools' },
  { key: 'reviews', title: 'Reviews' },
  { key: 'permissions', title: 'Permissions' },
  { key: 'glass', title: 'Glass' },
  { key: 'pet', title: 'Pet' },
  { key: 'wharves', title: 'Wharves' },
];

/** A repo setting with a default the loader leaves unset. */
const REPO_DEFAULTS: Readonly<Record<string, unknown>> = { reviewTool: 'github' };

function repoSettings(cfg: Config, repo: string, file: unknown): SettingsRepo {
  const effective = { ...REPO_DEFAULTS, ...cfg.repos[repo] };
  const fileRepo = isTable(file) && isTable(file.repos) ? file.repos[repo] : undefined;
  const rows = settingRows(withFileOnlyValues(effective, fileRepo), ['repos', repo], file, 2);
  const heavy = cfg.heavy.repos?.[repo];
  if (heavy) rows.push(...settingRows(heavy, ['heavy', 'repos', repo], file, 2).map((row) => ({ ...row, key: row.key.replace(`${repo}.`, 'heavy.') })));
  const count = repoTrapCount(cfg, repo);
  const idle = count.stowed + count.ghosted;
  return { key: repo, traps: { used: count.used, ...(count.limit !== undefined ? { limit: count.limit } : {}), ...(idle ? { idle } : {}), ...(count.held.length ? { held: count.held } : {}) }, rows };
}

function settingSections(cfg: Config, file: unknown): SettingsSection[] {
  const effective = cfg as unknown as Record<string, unknown>;
  const fileTable = isTable(file) ? file : {};
  const known = new Set(SECTIONS.map((section) => section.key));
  const shown = [...SECTIONS];
  // Anything else the file sets is still its setting, even if the loader doesn't read it.
  for (const key of Object.keys(fileTable)) {
    if (!known.has(key) && key !== 'repos' && key !== 'grounds') shown.push({ key, title: key });
  }
  const sections = new Map<string, SettingRow[]>();
  for (const { key, title } of shown) {
    let value = withFileOnlyValues(effective[key], fileTable[key]);
    // Each repo's heavy settings show with that repo.
    if (key === 'heavy' && isTable(value)) {
      const { repos: _shownWithRepos, ...rest } = value;
      value = rest;
    }
    const rows = settingRows(value, [key], file, 0, isSecretKey(key)).map((row) => ({ ...row, key: row.key.includes('.') ? row.key.slice(key.length + 1) : row.key }));
    if (rows.length > 0) sections.set(title, [...(sections.get(title) ?? []), ...rows]);
  }
  return [...sections].map(([title, rows]) => ({ title, rows }));
}

/** The installed versions, and whether they agree with the CLI. */
function settingsVersions(now: number): GlassSettings['versions'] {
  const cli = lobstahVersion();
  const rows: SettingsVersion[] = [{ name: 'CLI', version: cli }];
  for (const [name, plugin] of [['Claude plugin', installedClaudePlugin()], ['Codex plugin', installedCodexPlugin()]] as const) {
    if (plugin) rows.push({ name, version: plugin.version });
  }
  let daemon: { heartbeat?: string; version?: string } | undefined;
  try {
    daemon = JSON.parse(fs.readFileSync(executorPath(), 'utf8')) as typeof daemon;
  } catch {
    // no daemon has run
  }
  if (daemon?.version) {
    const running = daemon.heartbeat !== undefined && now - Date.parse(daemon.heartbeat) < HEARTBEAT_STALE_MS;
    rows.push({ name: 'Daemon', version: daemon.version, ...(running ? {} : { note: 'not running' }) });
  }
  const differ = rows.slice(1).filter((row) => pluginDrift(row.version, cli) !== 'match');
  return {
    rows,
    match: differ.length === 0,
    text: differ.length === 0 ? 'All match' : `${differ.map((row) => row.name).join(' and ')} ${differ.length > 1 ? 'differ' : 'differs'} from the CLI`,
  };
}

/** Everything the Settings tab shows, already masked. Never throws: a config error is shown on the page. */
export function glassSettings(now = Date.now()): GlassSettings {
  const file = configPath();
  const versions = settingsVersions(now);
  try {
    const cfg = loadConfig();
    const raw: unknown = fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {};
    return {
      file,
      versions,
      grounds: groundsList(cfg).map((grounds) => ({ name: displayGrounds(grounds.name, cfg), repos: grounds.repos })),
      repos: Object.keys(cfg.repos).sort().map((repo) => repoSettings(cfg, repo, raw)),
      sections: settingSections(cfg, raw),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { file, error: looksSecret(reason) ? 'config.toml could not be loaded' : reason, versions, grounds: [], repos: [], sections: [] };
  }
}
