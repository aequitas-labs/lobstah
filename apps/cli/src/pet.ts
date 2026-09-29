import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lobstahHome } from '@lobstah/core';
import { servicePathEnv } from './service.js';

/**
 * The desktop pet as a login item. macOS only: a user LaunchAgent starts
 * the app at login (RunAtLoad) but never resurrects a deliberate quit
 * (KeepAlive false) — quitting the pet from its own menu should stick
 * until the next login. The binary is built from source (apps/pet) and
 * copied under ~/.lobstah/bin so the agent survives repo cleans; a locally
 * built binary needs no signing or notarization — Gatekeeper only gates
 * quarantined downloads.
 */

export function petBinaryHome(): string {
  return path.join(lobstahHome(), 'bin', 'LobstahPet');
}

export function petPlistFile(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'lobstah.pet.plist');
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPetPlist(binary: string, pathEnv: string, home: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>lobstah.pet</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>LOBSTAH_HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xml(path.posix.join(logDir, 'pet.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.posix.join(logDir, 'pet.err'))}</string>
</dict>
</plist>
`;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

export function installPet(binaryArg?: string): { file: string; binary: string; loaded: boolean; detail: string } {
  if (process.platform !== 'darwin') {
    throw new Error('the pet is macOS-only for now — transparent overlay windows need a per-platform build');
  }
  // Fresh builds outrank the installed copy — otherwise a reinstall finds
  // the old binary "already in place" and silently ships nothing new.
  const candidates = [
    binaryArg,
    path.join(process.cwd(), 'apps', 'pet', '.build', 'release', 'LobstahPet'),
    path.join(process.cwd(), '.build', 'release', 'LobstahPet'),
    path.join(process.cwd(), 'apps', 'pet', '.build', 'debug', 'LobstahPet'),
    path.join(process.cwd(), '.build', 'debug', 'LobstahPet'),
    petBinaryHome(),
  ].filter((c): c is string => c !== undefined);
  const source = candidates.find((c) => fs.existsSync(c));
  if (!source) {
    throw new Error(
      'no pet binary found — build it first (`cd apps/pet && swift build -c release`) ' +
        'and run install from the repo root, or pass --binary <path>',
    );
  }
  const binary = petBinaryHome();
  const file0 = petPlistFile();
  if (fs.existsSync(file0)) run('launchctl', ['unload', file0]);
  run('pkill', ['-f', 'LobstahPet']);
  if (path.resolve(source) !== path.resolve(binary)) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.rmSync(binary, { force: true }); // never write into a mapped executable
    fs.copyFileSync(source, binary);
    fs.chmodSync(binary, 0o755);
    // SwiftPM resolves Bundle.module next to the executable, falling back to
    // an absolute path into the BUILD tree — copy the resource bundle too,
    // or the installed pet silently depends on the repo checkout existing.
    const bundle = path.join(path.dirname(source), 'LobstahPet_LobstahPet.bundle');
    if (fs.existsSync(bundle)) {
      const dest = path.join(path.dirname(binary), 'LobstahPet_LobstahPet.bundle');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(bundle, dest, { recursive: true });
    }
  }
  const logDir = path.join(lobstahHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = petPlistFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderPetPlist(binary, servicePathEnv(process.execPath), lobstahHome(), logDir));
  const load = run('launchctl', ['load', file]);
  return { file, binary, loaded: load.ok, detail: load.ok ? 'label lobstah.pet — starts at login' : load.out };
}

export function uninstallPet(): { file: string; removed: boolean } {
  const file = petPlistFile();
  if (process.platform === 'darwin' && fs.existsSync(file)) run('launchctl', ['unload', file]);
  const removed = fs.existsSync(file);
  if (removed) fs.unlinkSync(file);
  run('pkill', ['-f', 'LobstahPet']);
  return { file, removed };
}

/**
 * The pet's one write: the result of its last attention read, rewritten
 * after every read (about every six seconds). `lobstah doctor` reads it; the
 * pet itself never reads it back. Fields match PetState in
 * apps/pet/Sources/LobstahPetCore/ReadMonitor.swift.
 */
export interface PetState {
  pid: number;
  at: string;
  ok: boolean;
  command?: string;
  reason?: string;
  consecutiveFailures: number;
  items?: number;
  lastOkAt?: string;
}

export function petStateFile(): string {
  return path.join(lobstahHome(), 'pet', 'state.json');
}

export function readPetState(): PetState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(petStateFile(), 'utf8')) as PetState;
    return typeof s.pid === 'number' && typeof s.at === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** A running pet rewrites its state at least every ~30 s (6 s polls, two 10 s reads at worst). */
export const PET_STATE_STALE_MS = 120_000;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The doctor's pet row: installed or not, running or not, and whether the
 * last read worked. It reads the state file and signals nothing: running
 * means the recorded pid is alive and the state is fresh.
 */
export function petRow(
  opts: { now?: number; plist?: string; binary?: string; alive?: (pid: number) => boolean; platform?: NodeJS.Platform } = {},
): { check: string; status: 'ok' | 'warn' | 'skip'; detail: string } {
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? processAlive;
  const agent = fs.existsSync(opts.plist ?? petPlistFile());
  const binary = fs.existsSync(opts.binary ?? petBinaryHome());
  const installed = agent ? 'installed' : binary ? 'binary installed, no login agent' : 'not installed';
  const state = readPetState();
  if (!state) {
    if ((opts.platform ?? process.platform) !== 'darwin' && !agent && !binary) {
      return { check: 'pet', status: 'skip', detail: 'macOS only' };
    }
    return agent || binary
      ? { check: 'pet', status: 'warn', detail: `${installed}; not running (no ${petStateFile()} — or a pet older than this CLI)` }
      : { check: 'pet', status: 'skip', detail: 'not installed (`lobstah pet install`)' };
  }
  const age = now - Date.parse(state.at);
  const running = alive(state.pid) && age < PET_STATE_STALE_MS;
  const last = state.ok
    ? `last read worked ${ago(age)} (\`lobstah ${state.command ?? '?'}\`, ${state.items ?? 0} walking)`
    : `last read failed ${ago(age)}, ${state.consecutiveFailures} in a row: ${state.reason ?? 'unknown'}; ` +
      (state.lastOkAt ? `last worked ${ago(now - Date.parse(state.lastOkAt))}` : 'never worked');
  if (!running) {
    const why = alive(state.pid) ? `pid ${state.pid} has not read for ${ago(age).replace(' ago', '')}` : 'not running';
    return { check: 'pet', status: agent || binary ? 'warn' : 'skip', detail: `${installed}; ${why}; ${last}` };
  }
  return { check: 'pet', status: state.ok ? 'ok' : 'warn', detail: `${installed}; running (pid ${state.pid}); ${last}` };
}
