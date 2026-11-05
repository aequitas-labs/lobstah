import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConfiguredTrapProfile } from './configured-trap-model.js';
export type { ConfiguredTrapProfile, ConfiguredTrapLocation, ConfiguredTrapTarget, RepoDispatchTarget } from './configured-trap-model.js';

/** Validate all configured profiles before creating folders or reserving workers. */
export function parseConfiguredTraps(raw: unknown, grounds: Record<string, unknown>): Record<string, ConfiguredTrapProfile> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('[traps] must be a table');
  const profiles: Record<string, ConfiguredTrapProfile> = {};
  for (const [name, value] of Object.entries(raw)) {
    const where = `[traps.${name}]`;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error(`${where}: name must start with a lowercase letter and contain lowercase letters, digits or hyphens`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be a table`);
    const profile = value as Record<string, unknown>;
    for (const key of Object.keys(profile)) if (!['harness', 'surface', 'grounds', 'cwd', 'terminal', 'maxInstances'].includes(key)) throw new Error(`${where}.${key}: unknown key`);
    if (profile.harness !== 'claude' && profile.harness !== 'codex') throw new Error(`${where}.harness must be claude or codex`);
    if (profile.surface !== 'terminal' && profile.surface !== 'claude-desktop') throw new Error(`${where}.surface must be terminal or claude-desktop`);
    if (profile.surface === 'claude-desktop' && profile.harness !== 'claude') throw new Error(`${where}.surface claude-desktop requires harness claude`);
    const owner = Object.keys(grounds).length === 0 && profile.grounds === 'home' ? 'fleet' : profile.grounds;
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner) || !(Object.keys(grounds).length === 0 ? owner === 'fleet' : Object.hasOwn(grounds, owner))) throw new Error(`${where}.grounds must name a configured grounds`);
    const maxInstances = profile.maxInstances ?? 1;
    if (typeof maxInstances !== 'number' || !Number.isSafeInteger(maxInstances) || maxInstances < 1) throw new Error(`${where}.maxInstances must be a positive integer`);
    if (profile.terminal !== undefined && (profile.surface !== 'terminal' || !['terminal', 'iterm', 'tmux'].includes(String(profile.terminal)))) throw new Error(`${where}.terminal is valid only for a terminal surface and must be terminal, iterm or tmux`);
    let cwd: string | undefined;
    if (profile.cwd !== undefined) {
      if (typeof profile.cwd !== 'string' || !profile.cwd) throw new Error(`${where}.cwd must be an existing directory`);
      const expanded = profile.cwd.startsWith('~/') ? path.join(os.homedir(), profile.cwd.slice(2)) : profile.cwd;
      if (!path.isAbsolute(expanded)) throw new Error(`${where}.cwd must be absolute or start with ~/`);
      try { cwd = fs.realpathSync(expanded); if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory'); }
      catch { throw new Error(`${where}.cwd must be an existing directory: ${expanded}`); }
    }
    profiles[name] = { harness: profile.harness, surface: profile.surface, grounds: owner, maxInstances, ...(cwd ? { cwd } : {}), ...(profile.terminal ? { terminal: profile.terminal as ConfiguredTrapProfile['terminal'] } : {}) };
  }
  return profiles;
}
