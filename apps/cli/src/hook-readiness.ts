import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { hasOpenCatch, helmLabel, listHelms, listTraps, trapLabel } from '@lobstah/core';
import type { HelmRegistration, TrapRegistration } from '@lobstah/core';
import { LOBSTAH_HOOKS, readHookRuns } from './hook-runs.js';
import type { LobstahHook } from './hook-runs.js';
import { installedClaudePlugin, installedCodexPlugin, UPDATE_COMMAND } from './plugin-version.js';
import type { InstalledPlugin } from './plugin-version.js';
import { liveWatcher } from './watchers.js';

/** One lobstah hook in one harness, as `lobstah doctor` reports it. */
export interface HookReadiness {
  hook: LobstahHook;
  /** The plugin declares it. */
  installed: boolean;
  /** Codex: a trust entry exists for it. Claude Code has no per-hook trust: `n/a`. */
  trusted: boolean | 'n/a';
  /** Not turned off in the harness (a disabled hook, the plugin, or all hooks). */
  enabled: boolean;
  /** The last run lobstah recorded (ISO). */
  lastRun?: string;
}

export interface HarnessHooks {
  harness: 'claude' | 'codex';
  plugin?: InstalledPlugin;
  hooks: HookReadiness[];
  /** Why every hook is off, when the harness turns hooks off as a whole. */
  allOff?: string;
}

interface Opts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

type HookGroups = Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;

/** The plugin's hooks.json events, or undefined when it has none. */
function pluginHooks(root: string): HookGroups | undefined {
  const file = readJson(path.join(root, 'hooks', 'hooks.json')) as { hooks?: HookGroups } | undefined;
  return file?.hooks;
}

/** Where lobstah's handler sits in an event's groups: `[group, handler]`. */
function lobstahHandler(groups: HookGroups[string] | undefined): [number, number] | undefined {
  for (const [g, group] of (groups ?? []).entries()) {
    const h = (group.hooks ?? []).findIndex((x) => typeof x.command === 'string' && x.command.trim().startsWith('lobstah '));
    if (h >= 0) return [g, h];
  }
  return undefined;
}

/** Codex's snake_case event label, as its hook trust keys use it. */
const snake = (hook: LobstahHook) => hook.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Codex: the plugin's hooks and Codex's own record of them. Codex runs a
 * plugin hook only after the user trusts it in `/hooks`; it records trust
 * under `[hooks.state."<plugin>:hooks/hooks.json:<event>:<group>:<handler>"]`
 * with a `trusted_hash`. Read-only: nothing here writes Codex's config.
 */
export function codexHooks(opts: Opts = {}): HarnessHooks {
  const env = opts.env ?? process.env;
  const plugin = installedCodexPlugin(opts);
  if (!plugin) return { harness: 'codex', hooks: [] };
  const codexDir = env.CODEX_HOME ?? path.join(opts.home ?? os.homedir(), '.codex');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as Record<string, unknown>;
  } catch {
    // An unreadable config trusts nothing.
  }
  const state = (((cfg.hooks ?? {}) as Record<string, unknown>).state ?? {}) as Record<string, { enabled?: boolean; trusted_hash?: string }>;
  const features = (cfg.features ?? {}) as Record<string, unknown>;
  const declared = pluginHooks(plugin.root);
  const runs = readHookRuns();
  const hooks = LOBSTAH_HOOKS.map((hook): HookReadiness => {
    const at = lobstahHandler(declared?.[hook]);
    const entry = at ? state[`lobstah@lobstah:hooks/hooks.json:${snake(hook)}:${at[0]}:${at[1]}`] : undefined;
    return {
      hook,
      installed: at !== undefined,
      trusted: typeof entry?.trusted_hash === 'string' && entry.trusted_hash.length > 0,
      enabled: entry?.enabled !== false,
      ...(runs[`codex:${hook}`] ? { lastRun: runs[`codex:${hook}`] } : {}),
    };
  });
  return {
    harness: 'codex',
    plugin,
    hooks,
    ...(features.hooks === false ? { allOff: 'Codex hooks are off ([features] hooks = false in config.toml)' } : {}),
  };
}

/**
 * Claude Code: the plugin's hooks. Claude Code has no per-hook trust; a
 * disabled plugin or `disableAllHooks` turns them off. Read-only.
 */
export function claudeHooks(opts: Opts = {}): HarnessHooks {
  const env = opts.env ?? process.env;
  const plugin = installedClaudePlugin(opts);
  if (!plugin) return { harness: 'claude', hooks: [] };
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(opts.home ?? os.homedir(), '.claude');
  const settings = (readJson(path.join(claudeDir, 'settings.json')) ?? {}) as { disableAllHooks?: boolean; enabledPlugins?: Record<string, boolean> };
  const declared = pluginHooks(plugin.root);
  const runs = readHookRuns();
  const pluginOn = settings.enabledPlugins?.['lobstah@lobstah'] !== false;
  const hooks = LOBSTAH_HOOKS.map(
    (hook): HookReadiness => ({
      hook,
      installed: lobstahHandler(declared?.[hook]) !== undefined,
      trusted: 'n/a',
      enabled: pluginOn,
      ...(runs[`claude:${hook}`] ? { lastRun: runs[`claude:${hook}`] } : {}),
    }),
  );
  return {
    harness: 'claude',
    plugin,
    hooks,
    ...(settings.disableAllHooks === true ? { allOff: 'Claude Code hooks are off (disableAllHooks in settings.json)' } : {}),
  };
}

const ago = (iso: string, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172_800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

/** The hooks each role needs: the helm parks and learns its charter; a trap also beats and stows. */
export const ROLE_HOOKS: Record<'helm' | 'trap', readonly LobstahHook[]> = {
  helm: ['Stop', 'SessionStart'],
  trap: LOBSTAH_HOOKS,
};

const list = (hooks: readonly LobstahHook[]) => (hooks.length === 1 ? hooks[0]! : `${hooks.slice(0, -1).join(', ')} and ${hooks.at(-1)}`);

/** The hooks of `need` that cannot run: missing, untrusted, or off. */
function notReady(h: HarnessHooks, need: readonly LobstahHook[]): LobstahHook[] {
  return need.filter((n) => {
    const x = h.hooks.find((y) => y.hook === n);
    return !!h.allOff || !x || !x.installed || !x.enabled || x.trusted === false;
  });
}

/**
 * One doctor row per harness with the plugin installed: readiness per role
 * (the helm needs Stop and SessionStart, a trap all four), then each hook's
 * installed, trusted, and last-run state. A hook that is missing, untrusted,
 * or off fails the row, and the remedy names the step.
 */
export function hookRow(h: HarnessHooks, now = Date.now()): { check: string; status: 'ok' | 'fail' | 'skip'; detail: string } {
  const check = `hooks ${h.harness}`;
  if (!h.plugin) return { check, status: 'skip', detail: 'plugin not installed' };
  const name = h.harness === 'codex' ? 'Codex' : 'Claude Code';
  const parts = h.hooks.map((x) => {
    const trust = x.trusted === 'n/a' ? 'trust n/a' : x.trusted ? 'trusted' : 'untrusted';
    const state = !x.installed ? 'missing' : [x.enabled ? 'installed' : 'installed but disabled', trust].join(', ');
    return `${x.hook}: ${state}, ${x.lastRun ? `last run ${ago(x.lastRun, now)}` : 'never run'}`;
  });
  const missing = h.hooks.filter((x) => !x.installed).map((x) => x.hook);
  const untrusted = h.hooks.filter((x) => x.installed && x.trusted === false).map((x) => x.hook);
  const disabled = h.hooks.filter((x) => x.installed && !x.enabled).map((x) => x.hook);
  const remedies: string[] = [];
  if (h.allOff) remedies.push(`${h.allOff}: turn hooks on`);
  if (missing.length) remedies.push(`the plugin does not declare ${list(missing)}: reinstall it (${UPDATE_COMMAND[h.harness]})`);
  if (h.harness === 'codex') {
    if (untrusted.length) remedies.push(`In Codex, open /hooks and trust lobstah's ${list(untrusted)} hook${untrusted.length > 1 ? 's' : ''}`);
    if (disabled.length) remedies.push(`In Codex, open /hooks and enable lobstah's ${list(disabled)} hook${disabled.length > 1 ? 's' : ''}`);
  } else if (disabled.length) {
    remedies.push('In Claude Code, enable the lobstah plugin (/plugin)');
  }
  const healthy = remedies.length === 0;
  const roles = (['helm', 'trap'] as const).map((role) => {
    const blocked = notReady(h, ROLE_HOOKS[role]);
    return `${role} ${blocked.length ? `not ready (needs ${list(blocked)})` : 'ready'}`;
  });
  return {
    check,
    status: healthy ? 'ok' : 'fail',
    detail: `${roles.join(', ')}. ${parts.join('; ')}${healthy ? '' : ` — ${name} skips these hooks, so parks and wakes cannot work. ${remedies.join('. ')}.`}`,
  };
}

/** A listener is live for a helm: a `man wait` watcher, or a park heartbeat in the Stop hook in the last few seconds. */
function helmListening(h: HelmRegistration, now: number): boolean {
  if (liveWatcher(h.sessionId, 'man', undefined, now)) return true;
  return now - (Date.parse(h.parkedAt ?? '') || 0) < 10_000;
}

/** A listener is live for a trap: a `soak --wait` watcher, or a park heartbeat in the last few seconds. */
function trapListening(t: TrapRegistration, now: number): boolean {
  if (liveWatcher(t.sessionId, 'trap', t.trapId, now)) return true;
  return now - (Date.parse(t.parkedAt ?? '') || 0) < 10_000;
}

/**
 * Whether each signed-on helm and trap has a listener: the helm a live
 * `man wait`, a trap a park. A trap working a catch needs none.
 */
export function listenerRow(now = Date.now()): { check: string; status: 'ok' | 'warn' | 'skip'; detail: string } {
  const helms = listHelms();
  const traps = listTraps();
  if (helms.length === 0 && traps.length === 0) return { check: 'listeners', status: 'skip', detail: 'no helm or trap signed on' };
  const quiet: string[] = [];
  const parts: string[] = [];
  for (const h of helms) {
    const on = helmListening(h, now);
    parts.push(`helm ${helmLabel(h)}: ${on ? 'listening' : 'not listening'}`);
    if (!on) quiet.push(`helm ${helmLabel(h)}`);
  }
  for (const t of traps) {
    const on = trapListening(t, now);
    const working = !on && hasOpenCatch(t);
    parts.push(`trap ${trapLabel(t)}: ${on ? 'parked' : working ? 'working a catch' : 'not listening'}`);
    if (!on && !working) quiet.push(`trap ${trapLabel(t)}`);
  }
  return {
    check: 'listeners',
    status: quiet.length ? 'warn' : 'ok',
    detail: `${parts.join('; ')}${quiet.length ? ` — no automatic wake reaches ${quiet.join(', ')} until it parks again` : ''}`,
  };
}
