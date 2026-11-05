import { readTrap } from './soak.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lobstahHome, atomicRenameSync, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import type { ConfiguredTrapLocation, ConfiguredTrapProfile } from './configured-traps.js';

/** A durable instance counts against its profile cap through stow, ghost and pending start. */
export interface ConfiguredTrapSlot extends ConfiguredTrapLocation {
  trapId: string;
  cwd: string;
  sessionId?: string;
}

function slotsDirectory(): string { return path.join(lobstahHome(), 'configured-traps'); }

/** Read durable instances without inspecting their folders or invoking git. */
export function configuredTrapSlots(profile?: string): ConfiguredTrapSlot[] {
  const directory = slotsDirectory();
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as ConfiguredTrapSlot)
    .filter((slot) => !profile || slot.profile === profile);
}

/** Serialize profile allocation and sign-on so concurrent sessions cannot exceed the cap. */
export function withConfiguredTrapSlot<T>(name: string, profile: ConfiguredTrapProfile, sessionId: string | undefined, action: (slot: ConfiguredTrapSlot) => T): T {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('invalid configured trap profile name');
  fs.mkdirSync(slotsDirectory(), { recursive: true });
  return withDirLock(path.join(slotsDirectory(), `${name}.lock`), () => {
    const slots = configuredTrapSlots(name);
    const own = sessionId ? slots.find((slot) => slot.sessionId === sessionId) : undefined;
    const available = own ?? slots.find((slot) => !readTrap(slot.trapId));
    if (!available && slots.length >= profile.maxInstances) throw new Error(`trap:${name} has ${slots.length}/${profile.maxInstances} reserved instances; return to an existing session or forget an idle instance`);
    const trapId = available?.trapId ?? randomBytes(4).toString('hex');
    const cwd = available?.cwd ?? profile.cwd ?? path.join(lobstahHome(), 'trap-workspaces', profile.grounds, name, trapId);
    if (available && available.grounds !== profile.grounds) throw new Error(`trap:${name} belongs to grounds ${available.grounds}; forget its idle instances before changing grounds`);
    const slot: ConfiguredTrapSlot = { trapId, cwd, profile: name, grounds: profile.grounds, surface: profile.surface, ...(sessionId ? { sessionId } : available?.sessionId ? { sessionId: available.sessionId } : {}) };
    if (!profile.cwd) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const file = path.join(slotsDirectory(), `${trapId}.json`);
    const writeSlot = (value: ConfiguredTrapSlot): void => {
      const temporary = uniqueTempPath(file);
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      atomicRenameSync(temporary, file);
    };
    // Persist identity before publishing a registration or starting an app.
    writeSlot(slot);
    fs.writeFileSync(path.join(slotsDirectory(), `${trapId}.folder`), cwd, { mode: 0o600 });
    try { return action(slot); }
    catch (error) {
      if (available) writeSlot(available); else fs.rmSync(file, { force: true });
      throw error;
    }
  }, { staleMs: 30_000, waitMs: 1000, busy: () => new Error(`trap:${name} allocation is busy; retry`) });
}

/** Forget only the durable slot; user folders, app sessions and catch history remain. */
export function forgetConfiguredTrapSlot(trapId: string): void {
  if (!/^[a-z0-9-]+$/.test(trapId)) throw new Error('invalid trap id');
  fs.rmSync(path.join(slotsDirectory(), `${trapId}.json`), { force: true });
}

/** Keep configured working folders out of git culls, even after an instance is forgotten. */
export function configuredFolderOverlaps(directory: string): boolean {
  const canonical = (folder: string): string => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
  const candidate = canonical(directory);
  if (!fs.existsSync(slotsDirectory())) return false;
  return fs.readdirSync(slotsDirectory()).filter((file) => file.endsWith('.folder')).some((file) => {
    const folder = canonical(fs.readFileSync(path.join(slotsDirectory(), file), 'utf8'));
    const relative = path.relative(candidate, folder), reverse = path.relative(folder, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) || (!reverse.startsWith('..') && !path.isAbsolute(reverse));
  });
}
