import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexHookHash, type CodexHook, type HookHandler } from './hook-readiness.js';
import { installedCodexPlugin } from './plugin-version.js';

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
 * Supply trust for only the installed plugin's exact, vetted lobstah commands
 * as a session flag. No persisted config writes, no blanket trust bypass,
 * and no changes to enabled=false or to any other hook's trust.
 *
 * hooks.state is one inline TOML value: plugin IDs contain dots and must not
 * be interpreted as dotted override paths. Codex merges session hook state
 * with user state field by field (codex-hooks config_rules).
 */
export function codexTrapHookArgs(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
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
  return entries.length ? ['-c', `hooks.state={${entries.join(',')}}`] : [];
}
