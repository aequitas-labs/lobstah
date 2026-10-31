import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { codexHookHash, type CodexHook, type HookHandler } from './hook-readiness.js';
import { installedCodexPlugin } from './plugin-version.js';

type HookGroups = Record<string, Array<{ matcher?: string; hooks?: HookHandler[] }>>;

/** One command hook from a hooks.json, under the key and hash Codex trusts it by. */
export interface CodexHookEntry {
  /** `<hooks.json path or plugin id>:<snake_event>:<group>:<handler>`. */
  key: string;
  event: string;
  command: string;
  hash: string;
}

/** A hook that would hold a Codex trap at "Hooks need review" before its first prompt. */
export interface CodexHookBlocker extends CodexHookEntry {
  /** In plain words: why Codex would ask about it. */
  reason: string;
}

const snakeEvent = (event: string): string => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/** The command hooks of one hooks.json, keyed the way Codex keys their trust. */
function hookEntries(source: string, hooks: HookGroups | undefined): CodexHookEntry[] {
  const out: CodexHookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const [g, group] of groups.entries()) {
      for (const [h, handler] of (Array.isArray(group?.hooks) ? group.hooks : []).entries()) {
        if (handler?.type !== 'command' || typeof handler.command !== 'string') continue;
        out.push({ key: `${source}:${snakeEvent(event)}:${g}:${h}`, event, command: handler.command,
          hash: codexHookHash(event as CodexHook, group.matcher, handler) });
      }
    }
  }
  return out;
}

const readHooks = (text: string | undefined): HookGroups | undefined => {
  if (text === undefined) return undefined;
  try {
    return (JSON.parse(text) as { hooks?: HookGroups }).hooks ?? {};
  } catch {
    return undefined;
  }
};

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

/**
 * The project hooks.json Codex loads for a checkout: in a linked worktree it
 * reads the main checkout's `.codex/hooks.json`, not the worktree's own
 * (observed with Codex 0.160.1), and keys its trust by that absolute path.
 */
export function codexProjectHooksFile(cwd: string): string | undefined {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  if (!common) return undefined;
  const root = path.basename(common) === '.git' ? path.dirname(common) : git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const file = root ? path.join(root, '.codex', 'hooks.json') : undefined;
  return file && fs.existsSync(file) ? file : undefined;
}

/**
 * The checkout's project hooks lobstah supplies session trust for: exactly
 * those Codex will load, and only when that file matches the
 * `.codex/hooks.json` committed at the checkout's HEAD. A local edit, or a
 * file the repo does not track, gets no trust from lobstah.
 */
export function codexProjectHookTrust(cwd: string): { file?: string; supplied: CodexHookEntry[]; unverified?: string } {
  const file = codexProjectHooksFile(cwd);
  if (!file) return { supplied: [] };
  const loaded = readHooks(fs.readFileSync(file, 'utf8'));
  const committed = readHooks(git(cwd, ['show', 'HEAD:.codex/hooks.json']));
  if (!loaded) return { file, supplied: [], unverified: `${file} is not valid hooks JSON` };
  if (!committed) return { file, supplied: [], unverified: `${file} is not committed at this checkout's HEAD` };
  if (!isDeepStrictEqual(loaded, committed)) return { file, supplied: [], unverified: `${file} differs from the .codex/hooks.json committed at this checkout's HEAD` };
  return { file, supplied: hookEntries(file, loaded) };
}

/** Codex's own trust record: `[hooks.state."<key>"]` in `$CODEX_HOME/config.toml`. */
function codexHookState(codexDir: string): Record<string, { enabled?: boolean; trusted_hash?: string }> {
  try {
    const cfg = parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as { hooks?: { state?: Record<string, { enabled?: boolean; trusted_hash?: string }> } };
    return cfg.hooks?.state ?? {};
  } catch {
    return {};
  }
}

/**
 * The hooks that would hold a Codex trap in `cwd` at "Hooks need review"
 * before its first prompt: the user's `$CODEX_HOME/hooks.json` and the
 * checkout's project hooks, less those Codex already trusts at their current
 * hash and those lobstah supplies for the session. A disabled hook never asks.
 */
export function codexTrapHookBlockers(cwd: string, opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): CodexHookBlocker[] {
  const env = opts.env ?? process.env;
  const codexDir = env.CODEX_HOME ?? path.join(opts.home ?? os.homedir(), '.codex');
  const state = codexHookState(codexDir);
  const userFile = path.join(codexDir, 'hooks.json');
  const user = fs.existsSync(userFile) ? hookEntries(userFile, readHooks(fs.readFileSync(userFile, 'utf8'))) : [];
  const project = codexProjectHookTrust(cwd);
  const loaded = project.file ? hookEntries(project.file, readHooks(fs.readFileSync(project.file, 'utf8'))) : [];
  const supplied = new Set(project.supplied.map((e) => e.key));
  const out: CodexHookBlocker[] = [];
  for (const e of [...user, ...loaded]) {
    const entry = state[e.key];
    if (entry?.enabled === false || entry?.trusted_hash === e.hash || supplied.has(e.key)) continue;
    const why = entry?.trusted_hash ? 'changed since it was trusted' : 'never trusted';
    out.push({ ...e, reason: project.unverified && e.key.startsWith(`${project.file}:`) ? `${why}; lobstah supplies no trust because ${project.unverified}` : why });
  }
  return out;
}

/** The commands this CLI authorizes for its own trap lifecycle, never repo hooks. */
const COMMANDS: Record<CodexHook, string> = {
  SessionStart: 'lobstah hook session-start',
  UserPromptSubmit: 'lobstah hook user-prompt-submit',
  PostToolUse: 'lobstah hook post-tool-use',
  PreToolUse: 'lobstah hook pre-tool-use',
  PermissionRequest: 'lobstah hook permission-request',
  Stop: 'lobstah hook stop',
  SessionEnd: 'lobstah hook session-end',
};

/**
 * Codex 0.160.1 blocks before its first prompt when any hook needs review.
 * Supply trust for only the installed plugin's exact, vetted lobstah commands,
 * and for `cwd`'s project hooks when they match the committed file (see
 * codexProjectHookTrust), as a session flag. No persisted config writes, no blanket trust bypass,
 * and no changes to enabled=false or to any other hook's trust.
 *
 * hooks.state is one inline TOML value: plugin IDs contain dots and must not
 * be interpreted as dotted override paths. Codex merges session hook state
 * with user state field by field (codex-hooks config_rules).
 */
export function codexTrapHookArgs(opts: { env?: NodeJS.ProcessEnv; home?: string; cwd?: string } = {}): string[] {
  const plugin = installedCodexPlugin(opts);
  if (!plugin) return [];
  const file = path.join(plugin.root, 'hooks', 'hooks.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ matcher?: string; hooks?: HookHandler[] }>> };
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error(`invalid lobstah hooks in ${file}`);
  const entries: string[] = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    const command = Object.hasOwn(COMMANDS, event) ? COMMANDS[event as CodexHook] : undefined;
    if (!command || !Array.isArray(groups)) throw new Error(`cannot authorize unknown lobstah hook ${event} in ${file}; update the CLI and plugin together`);
    for (const [g, group] of groups.entries()) {
      if (!Array.isArray(group.hooks)) throw new Error(`invalid ${event} hooks in ${file}`);
      for (const [h, handler] of group.hooks.entries()) {
        if (handler.type !== 'command' || handler.command !== command || (handler.commandWindows !== undefined && handler.commandWindows !== command)) {
          throw new Error(`cannot authorize ${event} in ${file}: expected exactly ${command}`);
        }
        const key = `lobstah@lobstah:hooks/hooks.json:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${g}:${h}`;
        entries.push(`${JSON.stringify(key)}={trusted_hash=${JSON.stringify(codexHookHash(event as CodexHook, group.matcher, handler))}}`);
      }
    }
  }
  // The checkout's own committed project hooks, keyed by the file Codex loads.
  for (const e of opts.cwd ? codexProjectHookTrust(opts.cwd).supplied : []) {
    entries.push(`${JSON.stringify(e.key)}={trusted_hash=${JSON.stringify(e.hash)}}`);
  }
  return entries.length ? ['-c', `hooks.state={${entries.join(',')}}`] : [];
}

/**
 * `lobstah doctor`: the hooks that would hold a Codex trap in each
 * configured repo at "Hooks need review" before it can sign on. Skips when
 * the Codex plugin is not installed. Read-only.
 */
export function codexTrapHooksRow(
  repos: Record<string, { path: string }>,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): { check: string; status: 'ok' | 'fail' | 'skip'; detail: string } {
  const check = 'codex trap hooks';
  if (!installedCodexPlugin(opts)) return { check, status: 'skip', detail: 'Codex plugin not installed' };
  const blocked: string[] = [];
  let supplied = 0;
  for (const [name, repo] of Object.entries(repos)) {
    if (!fs.existsSync(repo.path)) continue;
    supplied += codexProjectHookTrust(repo.path).supplied.length;
    const blockers = codexTrapHookBlockers(repo.path, opts);
    if (blockers.length) blocked.push(`${name}: ${blockers.map((b) => `${b.key} (\`${b.command}\`, ${b.reason})`).join('; ')}`);
  }
  if (blocked.length === 0) {
    return { check, status: 'ok', detail: `no hook would hold a Codex trap at hook review${supplied ? ` (lobstah supplies session trust for ${supplied} committed project hook${supplied > 1 ? 's' : ''})` : ''}` };
  }
  return {
    check,
    status: 'fail',
    detail: `a Codex trap stops at "Hooks need review" and cannot sign on — ${blocked.join(' · ')}. Trust them in Codex's /hooks, or commit the project's .codex/hooks.json as checked out`,
  };
}
