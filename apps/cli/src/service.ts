import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPILED_BINARY, lobstahHome, onPath } from '@lobstah/core';

export type ServiceKind = 'daemon' | 'pick';

export interface ServiceSpec {
  kind: ServiceKind;
  /** Absolute node binary — launchd/systemd get no shell environment. */
  nodePath: string;
  /** Absolute path to lobstah's dist/main.js; empty for the compiled binary, which is its own entry. */
  entry: string;
  /** PATH the service runs with; must reach git and the harness CLIs. */
  pathEnv: string;
  home: string;
  logDir: string;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>lobstah.${spec.kind}</string>
  <key>ProgramArguments</key>
  <array>
${[spec.nodePath, spec.entry, spec.kind]
  .filter(Boolean)
  .map((a) => `    <string>${xml(a)}</string>`)
  .join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(spec.pathEnv)}</string>
    <key>LOBSTAH_HOME</key><string>${xml(spec.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.posix.join(spec.logDir, `${spec.kind}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.posix.join(spec.logDir, `${spec.kind}.err`))}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=lobstah ${spec.kind}

[Service]
ExecStart=${[spec.nodePath, spec.entry, spec.kind].filter(Boolean).join(' ')}
Restart=always
RestartSec=5
Environment=PATH=${spec.pathEnv}
Environment=LOBSTAH_HOME=${spec.home}
StandardOutput=append:${path.posix.join(spec.logDir, `${spec.kind}.log`)}
StandardError=append:${path.posix.join(spec.logDir, `${spec.kind}.err`)}

[Install]
WantedBy=default.target
`;
}

/**
 * The PATH a service unit needs: node's own directory (nvm installs live
 * nowhere a fresh env can see), the usual user/system bins, and the homebrew
 * prefix. Built from the live environment so a working shell setup carries
 * over instead of being re-guessed on every upgrade.
 */
export function servicePathEnv(nodePath: string, home = os.homedir()): string {
  // launchd/systemd units are POSIX targets — build the PATH with POSIX
  // semantics regardless of where this code happens to run (Windows CI).
  const dirs = [
    path.posix.dirname(nodePath),
    path.posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return [...new Set(dirs)].join(':');
}

export function serviceFile(kind: ServiceKind): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'LaunchAgents', `lobstah.${kind}.plist`)
    : path.join(os.homedir(), '.config', 'systemd', 'user', `lobstah-${kind}.service`);
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** Write the unit for this platform and load it. Idempotent: reinstalling reloads. */
export function installService(kind: ServiceKind): { file: string; loaded: boolean; detail: string } {
  if (process.platform === 'win32') {
    throw new Error(`no service manager support on Windows — run \`lobstah ${kind}\` under your process manager of choice`);
  }
  // The compiled binary is its own entry; realpath of argv[1] only exists
  // for the node layout (dist/main.js).
  const entry = COMPILED_BINARY ? '' : fs.realpathSync(process.argv[1]!);
  const spec: ServiceSpec = {
    kind,
    nodePath: process.execPath,
    entry,
    pathEnv: servicePathEnv(process.execPath),
    home: lobstahHome(),
    logDir: path.join(lobstahHome(), 'logs'),
  };
  if (!onPath('git', spec.pathEnv)) {
    throw new Error(`git is not reachable on the service PATH (${spec.pathEnv}) — the daemon cannot allocate worktrees`);
  }
  fs.mkdirSync(spec.logDir, { recursive: true });
  const file = serviceFile(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (process.platform === 'darwin') {
    if (fs.existsSync(file)) run('launchctl', ['unload', file]);
    fs.writeFileSync(file, renderLaunchdPlist(spec));
    const load = run('launchctl', ['load', file]);
    return { file, loaded: load.ok, detail: load.ok ? `label lobstah.${kind}` : load.out };
  }
  fs.writeFileSync(file, renderSystemdUnit(spec));
  run('systemctl', ['--user', 'daemon-reload']);
  const enable = run('systemctl', ['--user', 'enable', '--now', `lobstah-${kind}.service`]);
  return { file, loaded: enable.ok, detail: enable.ok ? `unit lobstah-${kind}.service` : enable.out };
}

export function uninstallService(kind: ServiceKind): { file: string; removed: boolean } {
  const file = serviceFile(kind);
  if (process.platform === 'darwin') {
    if (fs.existsSync(file)) run('launchctl', ['unload', file]);
  } else {
    run('systemctl', ['--user', 'disable', '--now', `lobstah-${kind}.service`]);
  }
  const removed = fs.existsSync(file);
  if (removed) fs.unlinkSync(file);
  if (process.platform !== 'darwin') run('systemctl', ['--user', 'daemon-reload']);
  return { file, removed };
}
