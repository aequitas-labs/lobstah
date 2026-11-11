import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPILED_BINARY, lobstahHome, lobstahVersion } from '@lobstah/core';
import { servicePathEnv } from './service.js';

/**
 * The desktop pet as a login item. macOS only: a user LaunchAgent starts
 * the app at login (RunAtLoad) but never resurrects a deliberate quit
 * (KeepAlive false) — quitting the pet from its own menu should stick
 * until the next login. `pet install` builds the binary from the pet's
 * Swift package (apps/pet, shipped in the npm package as pet/) and copies
 * it under ~/.lobstah/bin so the agent survives repo cleans; a locally
 * built binary needs no signing or notarization — Gatekeeper only gates
 * quarantined downloads. A stamp beside the binary records the lobstah
 * version it was built from, so doctor and the daemon can tell a pet
 * left behind by an upgrade.
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

/** The lobstah build an installed pet came from, written by `pet install` beside the binary. */
export interface PetStamp {
  /** The lobstah version whose pet sources built it; `unknown` for a binary passed with --binary. */
  version: string;
  /** Built from the pet's sources, or copied from a binary someone else built. */
  from: 'source' | 'binary';
  /** The sources' directory, or the copied binary. */
  path: string;
  at: string;
}

/** The version a pet installed with --binary records: nobody knows what it was built from. */
export const UNKNOWN_PET_VERSION = 'unknown';

export function petStampFile(): string {
  return path.join(lobstahHome(), 'bin', 'LobstahPet.stamp.json');
}

export function readPetStamp(file = petStampFile()): PetStamp | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as PetStamp;
    return typeof s.version === 'string' && (s.from === 'source' || s.from === 'binary') ? s : undefined;
  } catch {
    return undefined;
  }
}

function writePetStamp(stamp: PetStamp): void {
  fs.mkdirSync(path.dirname(petStampFile()), { recursive: true });
  fs.writeFileSync(petStampFile(), `${JSON.stringify(stamp, null, 2)}\n`);
}

/**
 * Why an installed pet is behind this CLI, or undefined when it isn't. A pet
 * with no stamp predates stamps, so it is older than any CLI that writes one.
 * A pet installed with --binary has no known version and is never called stale.
 */
export function petStaleReason(stamp: PetStamp | undefined, cli = lobstahVersion()): string | undefined {
  if (!stamp) return 'its build is older than version stamps';
  if (stamp.version === UNKNOWN_PET_VERSION || stamp.version === cli) return undefined;
  return `it was built from v${stamp.version}, the CLI is v${cli}`;
}

/**
 * The pet's Swift package that ships with this CLI: `pet/` beside the npm
 * package's dist/, or apps/pet in a checkout. A compiled binary carries none.
 */
export function petSourceDir(): string | undefined {
  if (COMPILED_BINARY) return undefined;
  for (const rel of ['../pet/', '../../pet/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(path.join(dir, 'Package.swift')) && fs.existsSync(path.join(dir, 'Sources', 'LobstahPet'))) return path.resolve(dir);
  }
  return undefined;
}

/** A release build of the pet: the binary it made, or the build's output when it failed. */
export interface PetBuild {
  ok: boolean;
  binary?: string;
  out: string;
}

/** Build the pet with SwiftPM, its scratch space under the lobstah home so the package directory may be read-only. */
export function buildPet(sources: string): PetBuild {
  const scratch = path.join(lobstahHome(), 'pet', 'build');
  const res = run('swift', ['build', '-c', 'release', '--product', 'LobstahPet', '--package-path', sources, '--scratch-path', scratch]);
  const binary = path.join(scratch, 'release', 'LobstahPet');
  return res.ok && fs.existsSync(binary) ? { ok: true, binary, out: res.out } : { ok: false, out: res.out || 'swift build failed' };
}

/** The last line of a build's output worth showing: the error, not the progress. */
function buildFailure(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error:/.test(l)) ?? lines.at(-1) ?? 'swift build failed';
}

/** What `pet install` did: where the binary came from, and a warning when the pet it left is not this CLI's. */
export interface PetInstall {
  file: string;
  binary: string;
  loaded: boolean;
  detail: string;
  /** `built from <sources>`, `copied <binary>`, or `reused the installed binary`. */
  source: string;
  /** The stamp's version after install. */
  version: string;
  warning?: string;
}

export function installPet(
  opts: {
    binary?: string;
    /** The pet's sources; null for none (a compiled binary). Defaults to petSourceDir(). */
    sources?: string | null;
    build?: (sources: string) => PetBuild;
    /** false writes the files but leaves launchctl and the running pet alone (tests). */
    load?: boolean;
    plist?: string;
    platform?: NodeJS.Platform;
  } = {},
): PetInstall {
  if ((opts.platform ?? process.platform) !== 'darwin') {
    throw new Error('the pet is macOS-only for now — transparent overlay windows need a per-platform build');
  }
  const binary = petBinaryHome();
  const sources = opts.sources === null ? undefined : (opts.sources ?? petSourceDir());
  let source: string;
  let stamp: PetStamp | undefined;
  let warning: string | undefined;
  if (opts.binary) {
    if (!fs.existsSync(opts.binary)) throw new Error(`no pet binary at ${opts.binary}`);
    source = opts.binary;
    stamp = { version: UNKNOWN_PET_VERSION, from: 'binary', path: path.resolve(opts.binary), at: new Date().toISOString() };
  } else {
    // Always build: a build left in a checkout, or the installed copy, may be any age.
    const built = sources ? (opts.build ?? buildPet)(sources) : undefined;
    if (built?.ok && built.binary) {
      source = built.binary;
      stamp = { version: lobstahVersion(), from: 'source', path: sources!, at: new Date().toISOString() };
    } else {
      const why = sources
        ? `could not build the pet from ${sources}: ${buildFailure(built!.out)}`
        : 'this lobstah ships no pet sources (a compiled binary)';
      if (!fs.existsSync(binary)) {
        throw new Error(`${why} — install Xcode's command line tools (xcode-select --install) and run it again, or pass --binary <path>`);
      }
      const old = readPetStamp();
      source = binary;
      warning = `${why}; reused the installed binary (${old ? `built from v${old.version}` : 'build unknown, older than version stamps'}), not a pet for v${lobstahVersion()}`;
    }
  }
  const file = opts.plist ?? petPlistFile();
  if (opts.load !== false) {
    if (fs.existsSync(file)) run('launchctl', ['unload', file]);
    run('pkill', ['-f', 'LobstahPet']);
  }
  if (path.resolve(source) !== path.resolve(binary)) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.rmSync(binary, { force: true }); // never write into a mapped executable
    fs.copyFileSync(source, binary);
    fs.chmodSync(binary, 0o755);
    // SwiftPM resolves Bundle.module next to the executable, falling back to
    // an absolute path into the BUILD tree — copy the resource bundle too,
    // or the installed pet silently depends on the build directory existing.
    const bundle = path.join(path.dirname(source), 'LobstahPet_LobstahPet.bundle');
    if (fs.existsSync(bundle)) {
      const dest = path.join(path.dirname(binary), 'LobstahPet_LobstahPet.bundle');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(bundle, dest, { recursive: true });
    }
  }
  if (stamp) writePetStamp(stamp);
  const logDir = path.join(lobstahHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderPetPlist(binary, servicePathEnv(process.execPath), lobstahHome(), logDir));
  const load = opts.load === false ? { ok: false, out: 'not loaded' } : run('launchctl', ['load', file]);
  return {
    file,
    binary,
    loaded: load.ok,
    detail: load.ok ? 'label lobstah.pet — starts at login' : load.out,
    source: opts.binary ? `copied ${opts.binary}` : warning ? 'reused the installed binary' : `built from ${sources}`,
    version: (stamp ?? readPetStamp())?.version ?? 'unknown (older than version stamps)',
    ...(warning ? { warning } : {}),
  };
}

/** The daemon's one try per CLI version at rebuilding a stale pet, so a failing build doesn't repeat on every restart. */
function petRefreshFile(): string {
  return path.join(lobstahHome(), 'pet', 'refresh.json');
}

/**
 * An upgrade restarts the daemon, and the installed pet keeps running the
 * build it had. When the pet's login agent is installed, its stamp is behind
 * this CLI and this CLI ships the pet's sources, start `lobstah pet install`
 * detached (a release build takes a minute or two), once per CLI version.
 * Its output goes to logs/pet-install.log.
 */
export function refreshStalePet(
  opts: { platform?: NodeJS.Platform; sources?: string | null; plist?: string; spawnInstall?: (log: string) => void } = {},
): { from: string; to: string } | undefined {
  if ((opts.platform ?? process.platform) !== 'darwin' || !fs.existsSync(opts.plist ?? petPlistFile())) return undefined;
  const stamp = readPetStamp();
  if (!petStaleReason(stamp)) return undefined;
  if (!(opts.sources === null ? undefined : (opts.sources ?? petSourceDir()))) return undefined;
  const to = lobstahVersion();
  try {
    if ((JSON.parse(fs.readFileSync(petRefreshFile(), 'utf8')) as { version?: string }).version === to) return undefined;
  } catch { /* No try yet. */ }
  fs.mkdirSync(path.dirname(petRefreshFile()), { recursive: true });
  fs.writeFileSync(petRefreshFile(), `${JSON.stringify({ version: to, at: new Date().toISOString() })}\n`);
  const logDir = path.join(lobstahHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, 'pet-install.log');
  (opts.spawnInstall ?? spawnPetInstall)(log);
  return { from: stamp?.version ?? 'unstamped', to };
}

function spawnPetInstall(log: string): void {
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [fs.realpathSync(process.argv[1]!), 'pet', 'install'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.on('error', () => { /* The log and doctor say what happened. */ });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
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
 * The doctor's pet row: installed or not, running or not, whether the last
 * read worked, and whether the installed build is behind this CLI. It reads
 * the state and stamp files and signals nothing: running means the recorded
 * pid is alive and the state is fresh.
 */
export function petRow(
  opts: {
    now?: number;
    plist?: string;
    binary?: string;
    alive?: (pid: number) => boolean;
    platform?: NodeJS.Platform;
    stamp?: PetStamp | null;
    version?: string;
  } = {},
): { check: string; status: 'ok' | 'warn' | 'skip'; detail: string } {
  const row = petRunRow(opts);
  // Only a binary on disk has a build to be behind.
  if (!fs.existsSync(opts.binary ?? petBinaryHome())) return row;
  const stale = petStaleReason(opts.stamp === null ? undefined : (opts.stamp ?? readPetStamp()), opts.version);
  return stale ? { check: 'pet', status: 'warn', detail: `${row.detail}; out of date: ${stale} (run lobstah pet install)` } : row;
}

/** The pet row before its version check: installed, running, and the last read. */
function petRunRow(
  opts: { now?: number; plist?: string; binary?: string; alive?: (pid: number) => boolean; platform?: NodeJS.Platform },
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
