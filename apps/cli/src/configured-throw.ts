import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { codexTrapHookArgs } from './codex-startup.js';
import { listCodexHooks } from './codex-hook-list.js';
import { configuredTrapSlots, harnessProcessAlive, sessionHolders, sessionHolderText, sessionClaimedElsewhere, listTraps, readRoster, readTrap, requestDesktopStart, withConfiguredTrapSlot, configPermissionMode, modelForHarness, shellQuote, type Config, type DesktopStartResult, type TrapRegistration } from '@lobstah/core';
import { focusRegistration } from './focus.js';
import { harnessCommand, macTerminalAdapter, tmuxTerminalAdapter, startTimeoutSecs, type TerminalAdapter } from './throw.js';

/** Launch-only folder trust preserves an explicit untrusted ancestor and never inspects or trusts repo hooks. */
function configuredCodexFolderArgs(cwd: string): string[] {
  const configFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  let projects: Record<string, { trust_level?: string }> = {};
  try { projects = (parse(fs.readFileSync(configFile, 'utf8')) as { projects?: typeof projects }).projects ?? {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []; }
  const canonical = fs.realpathSync.native(cwd);
  for (const [folder, project] of Object.entries(projects)) {
    let ancestor = path.resolve(folder);
    try { ancestor = fs.realpathSync.native(ancestor); } catch { /* Keep the recorded spelling when its folder is absent. */ }
    const relative = path.relative(ancestor, canonical);
    if (project.trust_level === 'untrusted' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return [];
  }
  return ['-c', `projects={${JSON.stringify(canonical)}={trust_level="trusted"}}`];
}

/** A configured start never creates a git checkout or substitutes a terminal for a desktop session. */
export type ConfiguredThrowResult = DesktopStartResult | { state: 'listening' | 'starting' | 'live'; profile: string; trapId: string; seconds: number; registration?: TrapRegistration };

/** Start the profile's actual surface; a desktop returns a concrete app-start card for its next turn. */
export async function throwConfiguredTrap(config: Config, name: string, by: string, options: { command?: string; adapter?: TerminalAdapter; timeoutSecs?: number; pollMs?: number } = {}): Promise<ConfiguredThrowResult> {
  const profile = config.traps?.[name];
  if (!profile) throw new Error(`unknown configured trap trap:${name}`);
  const live = listTraps().find((trap) => trap.configured?.profile === name && trap.configured.grounds === profile.grounds);
  if (live) { await focusRegistration(live); return { state: 'live', profile: name, trapId: live.trapId, seconds: 0, registration: live }; }
  if (profile.surface === 'claude-desktop') return requestDesktopStart(config, name, by, options.command);
  const priorSlot = configuredTrapSlots(name)[0], roster = priorSlot ? readRoster(priorSlot.trapId) : undefined;
  if (roster?.harnessProcess && harnessProcessAlive(roster.harnessProcess)) throw new Error(`trap:${name} still has a running ${roster.harness} process; return to its session instead of starting another writer`);
  // A saved session held anywhere must not gain a second terminal writer.
  if (roster?.sessionId) {
    const holders = sessionHolders(roster.sessionId);
    if (holders.length) throw new Error(`not starting trap:${name}: ${sessionHolderText(roster.sessionId, holders)}`);
  }
  // A stale duplicate roster claim starts cold, as the repo throw path does.
  const resumeSession = roster?.harness === profile.harness && !sessionClaimedElsewhere(roster.sessionId, roster.trapId) ? roster.sessionId : undefined;
  const slot = withConfiguredTrapSlot(name, profile, undefined, (instance) => instance);
  const command = options.command ?? 'lobstah';
  const permissionMode = configPermissionMode(config, undefined, profile.harness) ?? 'auto';
  const launch = harnessCommand({ harness: profile.harness, cwd: slot.cwd, model: modelForHarness(profile.harness, config.harness.model).model,
    config: { permissionMode, ...(config.harness.effort ? { effort: config.harness.effort } : {}) }, ...(resumeSession ? { resume: resumeSession } : {}),
    prompt: `Run ${command} soak --trap ${name} --grounds ${profile.grounds} --session <your own session id> --wait. Use the harness session id announced at session start.` });
  if (profile.harness === 'codex') launch.argv.splice(1, 0, '-c', 'check_for_update_on_startup=false', ...configuredCodexFolderArgs(slot.cwd), ...codexTrapHookArgs({ listed: await listCodexHooks(slot.cwd) }));
  const terminal = profile.terminal ?? config.soak.terminal ?? 'terminal';
  const adapter = options.adapter ?? (terminal === 'tmux' ? tmuxTerminalAdapter(config) : macTerminalAdapter(terminal));
  const started = Date.now();
  await adapter.launch({ ...launch, trap: `trap:${name}` });
  const deadline = started + startTimeoutSecs({ cfg: config, timeoutSecs: options.timeoutSecs }, profile.harness) * 1000;
  while (Date.now() < deadline) {
    const registration = readTrap(slot.trapId);
    if (registration?.firstParkedAt) return { state: 'listening', profile: name, trapId: slot.trapId, seconds: (Date.now() - started) / 1000, registration };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  return { state: 'starting', profile: name, trapId: slot.trapId, seconds: (Date.now() - started) / 1000 };
}

/** Use this build's entry point in a preview without changing the installed CLI or its configuration. */
export function configuredSignOnCommand(): string {
  return `${shellQuote(process.execPath)} ${shellQuote(process.argv[1]!)}`;
}
