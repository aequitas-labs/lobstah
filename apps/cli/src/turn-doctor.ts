import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { readTrap, trapLabel } from '@lobstah/core';
import { readSeenTurnTools, readTurnWaitRecords } from './turn-waits.js';

/**
 * Doctor's `turn waits` row: the turn-end contract (docs/turn-end.md) from
 * lobstah's side. It names no tool. It lists every Stop hook that isn't
 * lobstah's, says which ones have registered a wait with a trap, and shows
 * the waits lobstah runs. It only reports.
 */

/** A Stop hook that waits longer than this could hold a trap's turn end. */
const LONG_STOP_SECS = 60;
/** A wait that has failed this many times in a row is worth a warning. */
const FAILING_AFTER = 3;

/** One Stop hook that isn't lobstah's, where a harness loads it from. */
export interface OtherStopHook {
  harness: 'claude' | 'codex';
  /** The plugin (`name@marketplace`) or settings file it comes from. */
  source: string;
  command: string;
  /** Seconds, when the definition says. */
  timeout?: number;
}

interface Opts {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

type HookFile = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown; timeout?: unknown }> }>> };

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** The Stop handlers in one hooks file that aren't lobstah's. */
function stopHandlers(file: HookFile | undefined, harness: OtherStopHook['harness'], source: string): OtherStopHook[] {
  return (file?.hooks?.Stop ?? []).flatMap((group) =>
    (group.hooks ?? []).flatMap((h) =>
      typeof h.command === 'string' && !/^lobstah\s/.test(h.command.trim())
        ? [{ harness, source, command: h.command.trim(), ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}) }]
        : [],
    ),
  );
}

/** Claude Code: user settings and every enabled plugin other than lobstah. */
function claudeStopHooks(opts: Opts): OtherStopHook[] {
  const env = opts.env ?? process.env;
  const dir = env.CLAUDE_CONFIG_DIR ?? path.join(opts.home ?? os.homedir(), '.claude');
  const settings = readJson<HookFile & { enabledPlugins?: Record<string, boolean> }>(path.join(dir, 'settings.json'));
  const out = stopHandlers(settings, 'claude', 'settings.json');
  const installed = readJson<{ plugins?: Record<string, Array<{ installPath?: string }>> }>(path.join(dir, 'plugins', 'installed_plugins.json'));
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    if (key === 'lobstah@lobstah' || settings?.enabledPlugins?.[key] === false) continue;
    const root = entries[0]?.installPath;
    if (root) out.push(...stopHandlers(readJson<HookFile>(path.join(root, 'hooks', 'hooks.json')), 'claude', key));
  }
  return out;
}

/** Codex: its user hooks.json and every enabled plugin other than lobstah, newest cached version. */
function codexStopHooks(opts: Opts): OtherStopHook[] {
  const env = opts.env ?? process.env;
  const dir = env.CODEX_HOME ?? path.join(opts.home ?? os.homedir(), '.codex');
  const out = stopHandlers(readJson<HookFile>(path.join(dir, 'hooks.json')), 'codex', 'hooks.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = parse(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const [key, entry] of Object.entries((cfg.plugins ?? {}) as Record<string, { enabled?: boolean }>)) {
    if (key === 'lobstah@lobstah' || entry?.enabled === false) continue;
    const [name, market] = key.split('@');
    if (!name || !market) continue;
    const cache = path.join(dir, 'plugins', 'cache', market, name);
    let versions: string[];
    try {
      versions = fs.readdirSync(cache).sort();
    } catch {
      continue;
    }
    const newest = versions.at(-1);
    if (newest) out.push(...stopHandlers(readJson<HookFile>(path.join(cache, newest, 'hooks', 'hooks.json')), 'codex', key));
  }
  return out;
}

/** Every Stop hook a harness loads that isn't lobstah's. Read-only. */
export function otherStopHooks(opts: Opts = {}): OtherStopHook[] {
  return [...claudeStopHooks(opts), ...codexStopHooks(opts)];
}

/** The program a hook command runs: its first word's base name. */
export const hookProgram = (command: string): string => path.basename(command.split(/\s+/)[0] ?? '');

/**
 * The `turn waits` row. `ok` lists the other Stop hooks and the waits
 * running. `warn` when a long Stop hook's program has never registered a
 * wait with a trap, so it may hold a trap's turn end, or when a wait keeps
 * failing. `skip` when there is nothing to show.
 */
export function turnWaitsRow(opts: Opts = {}): { check: string; status: 'ok' | 'warn' | 'skip'; detail: string } {
  const check = 'turn waits';
  const hooks = otherStopHooks(opts);
  const records = readTurnWaitRecords();
  if (hooks.length === 0 && records.length === 0) return { check, status: 'skip', detail: 'no other Stop hook, and no wait registered with a trap' };
  const seen = readSeenTurnTools();
  const parts: string[] = [];
  const unregistered: string[] = [];
  for (const h of hooks) {
    const program = hookProgram(h.command);
    const long = h.timeout === undefined || h.timeout > LONG_STOP_SECS;
    const registers = seen.has(program);
    if (long && !registers) unregistered.push(`${h.source} (${h.harness})`);
    parts.push(`${h.harness} ${h.source}: \`${h.command}\`${h.timeout !== undefined ? ` (${h.timeout}s)` : ''}${registers ? ', registers its wait' : long ? ', never registered a wait' : ''}`);
  }
  const failing: string[] = [];
  for (const r of records) {
    const trap = readTrap(r.trapId);
    const who = trap ? trapLabel(trap) : `${r.trapId.slice(0, 8)} (gone)`;
    const state = r.failures ? `failing ${r.failures}x: ${r.lastError ?? 'no output'}` : 'running';
    if ((r.failures ?? 0) >= FAILING_AFTER) failing.push(`${r.from} for ${who}`);
    parts.push(`wait ${r.from} for ${who}${r.dispatch ? ` on ${r.dispatch.slice(0, 8)}` : ''}: ${state}`);
  }
  const remedies: string[] = [];
  if (unregistered.length)
    remedies.push(
      `${unregistered.join(', ')} ${unregistered.length > 1 ? 'have' : 'has'} a long Stop hook that has never registered a wait with a trap, so in a trap it may hold the turn end beside lobstah's park (see docs/turn-end.md)`,
    );
  if (failing.length) remedies.push(`${failing.join(', ')} keeps failing: run its wait command by hand to see why`);
  return { check, status: remedies.length ? 'warn' : 'ok', detail: `${parts.join('; ')}${remedies.length ? ` — ${remedies.join('. ')}.` : ''}` };
}
