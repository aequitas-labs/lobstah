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
  const candidates = [
    binaryArg,
    petBinaryHome(),
    path.join(process.cwd(), 'apps', 'pet', '.build', 'release', 'LobstahPet'),
    path.join(process.cwd(), '.build', 'release', 'LobstahPet'),
    path.join(process.cwd(), 'apps', 'pet', '.build', 'debug', 'LobstahPet'),
    path.join(process.cwd(), '.build', 'debug', 'LobstahPet'),
  ].filter((c): c is string => c !== undefined);
  const source = candidates.find((c) => fs.existsSync(c));
  if (!source) {
    throw new Error(
      'no pet binary found — build it first (`cd apps/pet && swift build -c release`) ' +
        'and run install from the repo root, or pass --binary <path>',
    );
  }
  const binary = petBinaryHome();
  if (path.resolve(source) !== path.resolve(binary)) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.copyFileSync(source, binary);
    fs.chmodSync(binary, 0o755);
  }
  const logDir = path.join(lobstahHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = petPlistFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) run('launchctl', ['unload', file]);
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
